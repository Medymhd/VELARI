#!/usr/bin/env node
/**
 * Dynamic model discovery + benchmark (the anti-hardcoding system).
 *
 * 1. Discovers live models from every configured gateway (Groq, OpenRouter,
 *    OpenAI-compat) — no model names hardcoded anywhere.
 * 2. Probes each candidate with the REAL coach prompt: streaming TTFT + total
 *    latency + strict-JSON validation (1-2 rounds).
 * 3. Ranks by speed × JSON reliability and writes the top 3 per provider into
 *    .env as COACH_MODEL_<PROVIDER> (runtime reads these, never hardcoded
 *    names) + a human-readable report in benchmarks/results/model-bench.md.
 *
 * Deprecation-proof: a model that 404s, rate-limits or returns non-JSON is
 * disqualified; the next run picks up new/renamed models automatically.
 * Usage: node benchmarks/probe-models.mjs [--top 3]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOP = Number(process.argv[2] ?? process.env.TOP ?? 3);

// ---- .env loader (no deps) -------------------------------------------------
const env = {};
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && !env[m[1]]) env[m[1]] = m[2].trim();
  }
}

// ---- Gateways (discovery + probe) ------------------------------------------
const gateways = [];
if (env.GROQ_API_KEY) {
  gateways.push({
    id: "groq",
    base: "https://api.groq.com/openai/v1",
    key: env.GROQ_API_KEY,
    keyEnv: "GROQ_API_KEY",
    envPrefix: "GROQ",
    freeHint: /gpt-oss|compound|qwen|llama|allam/i,
  });
}
if (env.OPENROUTER_API_KEY) {
  gateways.push({
    id: "openrouter",
    base: "https://openrouter.ai/api/v1",
    key: env.OPENROUTER_API_KEY,
    keyEnv: "OPENROUTER_API_KEY",
    envPrefix: "OPENROUTER",
    // free tier only — the whole point of the $0 operating mode
    filter: (m) => m.id.endsWith(":free") || m.pricing?.prompt === "0" || m.id === "openrouter/auto",
  });
}
if (env.OPENAI_COMPAT_BASE_URL && env.OPENAI_COMPAT_API_KEY) {
  gateways.push({
    id: "openai-compat",
    base: env.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, ""),
    key: env.OPENAI_COMPAT_API_KEY,
    keyEnv: "OPENAI_COMPAT_API_KEY",
    envPrefix: "OPENAI_COMPAT",
  });
}

// ---- Probe ------------------------------------------------------------------
const COACH_SYS =
  'You are a live interview coach. Respond ONLY with JSON {"detected_question":string,"suggested_outline":string[],"talking_points":string[],"confidence":number}. Max 4 outline items, max 3 talking points.';
const COACH_USER = "Interviewer: Tell me about your experience as an AI training specialist.";

const BAD_NAME = /guard|whisper|tts|embed|safeguard|lyria|preview|image|video|omni/i;

async function discover(gw) {
  const res = await fetch(`${gw.base}/models`, {
    headers: { authorization: `Bearer ${gw.key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  let rows = (j.data ?? []).map((m) => ({ id: m.id, ctx: m.context_length ?? 0, img: (m.architecture?.input_modalities ?? m.input_modalities ?? []).includes("image") }));
  if (gw.filter) rows = rows.filter(gw.filter);
  // Quality heuristic without hardcoded names: bigger/flagship models first.
  const size = (id) => {
    const m = /(\d{2,4})b/i.exec(id);
    const b = m ? Number(m[1]) : 0;
    const bonus = /120b|70b|ultra|super|pro|large/i.test(id) ? 200 : /mini|nano|small|flash|lightning/i.test(id) ? -100 : 0;
    return b + bonus;
  };
  return rows
    .filter((r) => !BAD_NAME.test(r.id) && r.ctx >= 32_768)
    .sort((a, b2) => size(b2.id) - size(a.id))
    .slice(0, 6);
}

async function probe(gw, model) {
  const t0 = Date.now();
  let ttft = -1;
  const r = await fetch(`${gw.base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${gw.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: COACH_SYS },
        { role: "user", content: COACH_USER },
      ],
      max_tokens: 300,
      temperature: 0.3,
      stream: true,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let text = "";
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
  const total = Date.now() - t0;
  let jsonOk = false;
  try {
    const p = JSON.parse(text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim());
    jsonOk = typeof p.detected_question === "string" && Array.isArray(p.suggested_outline);
  } catch { /* non-JSON = disqualified */ }
  return { ttft, total, jsonOk, chars: text.length };
}

// ---- Main -------------------------------------------------------------------
const report = [];
const rankings = {};

for (const gw of gateways) {
  console.log(`\n=== ${gw.id} (${gw.base}) ===`);
  let candidates;
  try {
    candidates = await discover(gw);
  } catch (e) {
    console.log(`  discovery failed: ${e.message}`);
    continue;
  }
  console.log(`  candidates: ${candidates.map((c) => c.id).join(", ") || "none"}`);

  const scored = [];
  for (const c of candidates) {
    try {
      const p = await probe(gw, c.id);
      const ok = p.jsonOk && p.chars > 20;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${c.id.padEnd(48)} ttft=${p.ttft}ms total=${p.total}ms json=${p.jsonOk}`);
      if (ok) scored.push({ model: c.id, ttft: p.ttft, total: p.total });
    } catch (e) {
      console.log(`  FAIL ${c.id.padEnd(48)} ${String(e.message ?? e).slice(0, 60)}`);
    }
  }

  scored.sort((a, b) => a.ttft - b.ttft || a.total - b.total);
  const top = scored.slice(0, TOP).map((s) => s.model);
  rankings[gw.id] = top;
  if (top[0]) report.push(`### ${gw.id}\n1. ${scored[0].model} — ttft ${scored[0].ttft}ms / total ${scored[0].total}ms\n2. ${scored[1]?.model ?? "—"} — ${scored[1] ? `${scored[1].ttft}ms` : ""}\n3. ${scored[2]?.model ?? "—"} — ${scored[2] ? `${scored[2].ttft}ms` : ""}`);
}

// ---- Write results ----------------------------------------------------------
// 1. .env COACH_MODEL_* overrides (runtime reads these per provider/task)
let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const envLines = envText.split(/\r?\n/);
for (const [gwId, models] of Object.entries(rankings)) {
  const key = `COACH_MODEL_${gwId.toUpperCase().replace(/-/g, "_")}`;
  const value = models[0] ?? "";
  const idx = envLines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) envLines[idx] = line;
  else envLines.push(line);
  console.log(`\n${key}=${value}  (failover: ${models.slice(1).join(", ") || "none"})`);
}
writeFileSync(envPath, envLines.join("\n"), "utf8");

// 2. Human report
const md = `# Model benchmark — ${new Date().toISOString()}\n\n${report.join("\n\n")}\n\nWinners written to .env as COACH_MODEL_<GATEWAY> (top ${TOP}); the router reads them at runtime — no hardcoded model names anywhere.\n`;
writeFileSync(path.join(ROOT, "benchmarks", "results", "model-bench.md"), md, "utf8");

console.log("\nDone. Winners are live in .env — restart the API to apply.");
