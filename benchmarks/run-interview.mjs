#!/usr/bin/env node
/**
 * Self-interview harness — sequential interview simulation against the live
 * coach prompt chain (questions from docs/samples/sample interview.docx).
 *
 * Simulates what the realtime pipeline does per interviewer turn:
 *   rolling transcript grows → coach prompt built with rolling context →
 *   measured model call (streaming TTFT + total + JSON validity).
 *
 * Measures the degradation curve: with single-flight + preemption + token
 * budget, question N's latency should stay flat vs question 1. A rising
 * curve means the coach is queuing behind itself.
 *
 * Usage: node benchmarks/run-interview.mjs [--rounds 1] [--questions 8]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);

// ---- env loader (mirror probe-models.mjs, no deps) --------------------------
const env = {};
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && m[1] && !env[m[1]]) env[m[1]] = m[2].trim();
  }
}
for (const k of Object.keys(process.env)) env[k] ??= process.env[k];

const { buildCoachMessages } = req("../verticals/interview-intelligence/dist/index.js");

// ---- Questions extracted from docs/samples/sample interview.docx ------------
// Ordered like the real interview: intro → fundamentals → scenarios → pressure.
const QUESTIONS = [
  { round: 1, text: "Tell me about yourself." },
  { round: 2, text: "Tell me about your experience as an AI Training Specialist." },
  { round: 2, text: "What is LLM evaluation?" },
  { round: 2, text: "How would you evaluate two AI responses?" },
  { round: 2, text: "What is a hallucination?" },
  { round: 3, text: "What is prompt engineering?" },
  { round: 4, text: "What makes good AI training data?" },
  { round: 4, text: "How would you evaluate an AI response using a rubric?" },
  { round: 5, text: "Suppose an AI generates Python code that works but contains a security vulnerability. How would you evaluate it?" },
  { round: 6, text: "What if an AI answer is technically correct but doesn't follow the instructions?" },
  { round: 7, text: "What would you do if an AI response contains bias?" },
  { round: 7, text: "Which response is better and why? Answer A gives specific libraries and meets the three-sentence format, Answer B is vague." },
];

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const ROUNDS = argOf("--rounds", 1);
const MAXQ = argOf("--questions", QUESTIONS.length);

// ---- Endpoint (same resolution the runtime uses: .env COACH_MODEL_*) --------
const ENDPOINTS = [];
if (env.GROQ_API_KEY) {
  ENDPOINTS.push({
    id: "groq",
    base: "https://api.groq.com/openai/v1",
    key: env.GROQ_API_KEY,
    model: env.COACH_MODEL_GROQ || "qwen/qwen3.8-27b",
    maxTokens: 512,
  });
}
if (env.OPENAI_COMPAT_BASE_URL && env.OPENAI_COMPAT_API_KEY) {
  ENDPOINTS.push({
    id: env.OPENAI_COMPAT_ID ?? "bai",
    base: env.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, ""),
    key: env.OPENAI_COMPAT_API_KEY,
    model: env.COACH_MODEL_BAI || "qwen3.8-flash",
    maxTokens: 512,
  });
}

// ---- Probe (mirrors the runtime: streaming, strict JSON, 512-token budget) --
const BAD = /<think>[\s\S]*?<\/think>/g;

async function coachCall(endpoint, messages, signal) {
  const t0 = Date.now();
  let ttft = -1;
  let text = "";
  const r = await fetch(`${endpoint.base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      max_tokens: endpoint.maxTokens,
      temperature: 0.3,
      stream: true,
    }),
    signal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value, { stream: true }).split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft < 0) ttft = Date.now() - t0;
          text += delta;
        }
      } catch { /* keepalive */ }
    }
  }
  const stripped = text.replace(BAD, "").replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
  let jsonOk = false;
  let q = "";
  try {
    const p = JSON.parse(stripped);
    jsonOk = typeof p.detected_question === "string" && Array.isArray(p.suggested_outline);
    q = p.detected_question ?? "";
  } catch { /* disqualified */ }
  return { ttft, total: Date.now() - t0, jsonOk, q, text: stripped.slice(0, 120) };
}

// ---- Simulate the conversation ----------------------------------------------
let transcriptTail = "";
const report = { startedAt: new Date().toISOString(), rounds: ROUNDS, endpoints: {} };

for (const ep of ENDPOINTS) {
  console.log(`\n=== ${ep.id} (${ep.model}) ===`);
  const perQuestion = [];
  for (let round = 1; round <= ROUNDS; round++) {
    transcriptTail = "";
    for (const q of QUESTIONS.slice(0, MAXQ)) {
      transcriptTail += `Interviewer: ${q.text}\n`;
      const messages = buildCoachMessages({
        verbatimTranscript: transcriptTail.slice(-4000),
        mode: "general",
      });
      let res;
      try {
        res = await coachCall(ep, messages, AbortSignal.timeout(30_000));
      } catch (e) {
        const msg = String(e.message ?? e);
        if (msg.includes("429")) {
          // Machine pacing trips the free tier — back off and retry once so
          // the latency curve reflects model speed, not the rate limiter.
          await new Promise((r2) => setTimeout(r2, 20_000));
          try {
            res = await coachCall(ep, messages, AbortSignal.timeout(30_000));
          } catch (e2) {
            res = { ttft: -1, total: -1, jsonOk: false, q: "", text: String(e2.message ?? e2).slice(0, 60) };
          }
        } else {
          res = { ttft: -1, total: -1, jsonOk: false, q: "", text: msg.slice(0, 60) };
        }
      }
      const tag = `r${round} q${transcriptTail.split("\n").length - 1}`;
      console.log(`  ${tag.padEnd(8)} ttft=${String(res.ttft).padStart(6)}ms  total=${String(res.total).padStart(6)}ms  json=${res.jsonOk ? "ok " : "BAD"}  ${res.text.slice(0, 48)}`);
      perQuestion.push({
        round,
        questionNo: transcriptTail.split("\n").length - 1,
        question: q.text.slice(0, 80),
        ttftMs: res.ttft,
        totalMs: res.total,
        jsonOk: res.jsonOk,
      });
      // Realistic interviewer pace (~3.5s per turn) — lets rate-limit windows drain.
      await new Promise((r2) => setTimeout(r2, 3_500));
  }
  }
  const ok = perQuestion.filter((p) => p.jsonOk);
  const first3 = ok.slice(0, 3);
  const last3 = ok.slice(-3);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, p) => x + p.totalMs, 0) / a.length) : -1);
  const drift = first3.length && last3.length ? Math.round(avg(last3) - avg(first3)) : null;
  report.endpoints[ep.id] = {
    model: ep.model,
    jsonValidity: ok.length / perQuestion.length,
    avgTotalMs: avg(ok),
    avgTtftMs: ok.length ? Math.round(ok.reduce((x, p) => x + p.ttftMs, 0) / ok.length) : -1,
    first3AvgMs: avg(first3),
    last3AvgMs: avg(last3),
    driftMs: drift,
    perQuestion,
  };
  console.log(`  → json=${(ok.length / perQuestion.length * 100).toFixed(0)}%  avgTotal=${avg(ok)}ms  drift(first3→last3)=${drift}ms`);
}

mkdirSync(path.join(ROOT, "benchmarks", "results"), { recursive: true });
writeFileSync(path.join(ROOT, "benchmarks", "results", "interview-sim.json"), JSON.stringify(report, null, 2));

const lines = [`# Self-interview simulation — ${report.startedAt}`, ""];
for (const [id, r] of Object.entries(report.endpoints)) {
  lines.push(
    `## ${id} (${r.model})`,
    `- JSON validity: ${(r.jsonValidity * 100).toFixed(0)}%`,
    `- Avg total latency: ${r.avgTotalMs}ms (TTFT ${r.avgTtftMs}ms)`,
    `- Degradation: first-3 avg ${r.first3AvgMs}ms → last-3 avg ${r.last3AvgMs}ms (drift ${r.driftMs}ms)`,
    `- Flat (drift ≤ 400ms) = single-flight/preemption working; rising = queuing`,
    "",
  );
}
writeFileSync(path.join(ROOT, "benchmarks", "results", "interview-sim.md"), lines.join("\n"), "utf8");
console.log("\nWrote benchmarks/results/interview-sim.md");
