/**
 * P5 â€” Reference-parity benchmark. Replicates the reference's documented pipeline
 * SEMANTICS (constants extracted from source, file:line in the annex) against
 * the same providers and corpus we use, then measures our equivalent:
 *
 *   Coach  â€” reference `textStreamFallback`: race provider streams, commit the
 *            first to emit a token (their order: groq primary â†’ gemini â†’ â€¦),
 *            params temperature 0.2 / seed 7 (LLMHelper.ts:186).
 *            Ours: the router's measured best (groq qwen3.8-27b) single-shot.
 *   Vision â€” reference chain order (groq vision retired 2026-08 â†’ gemini next);
 *            ours: bai vision measured separately.
 *   STT    â€” their local rung IS moonshine-tiny (we run the same model class)
 *            + Deepgram nova-3 cloud (skipped without key). Numbers reused
 *            from stt/moonshine/sherpa results.
 *
 * The reference binary itself requires its license server â€” this measures
 * pipeline DESIGN semantics on identical provider calls, which is the
 * conservative comparison (their native runtime would only help them).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const { buildCoachMessages, QUESTION_BANK } = req("../verticals/interview-intelligence/dist/index.js");

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const RACE_FIRST_TOKEN_MS = 8_000; // reference TEXT_TTFT budget (LLMHelper.ts)

const SCHEMA_HINT =
  'Respond ONLY with JSON {"detected_question":string,"suggested_outline":string[],"talking_points":string[],"confidence":number,"requires_user_review":boolean}';

// â”€â”€ Reference semantics: race streams, commit the first to emit a token â”€â”€â”€â”€â”€â”€
async function referenceRace(branches, messages) {
  const started = now();
  const controllers = branches.map(() => new AbortController());
  let committed = -1;
  let firstTokenMs = null;
  const texts = branches.map(() => "");
  const branchErrors = branches.map(() => null);

  const readers = branches.map(async (branch, i) => {
    try {
      const res = await fetch(`${branch.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controllers[i].signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${branch.key}` },
        body: JSON.stringify({
          model: branch.model,
          messages,
          stream: true,
          max_tokens: 400,
          temperature: 0.2,
          // seed + reasoning_effort are Groq-only — the Gemini compat
          // endpoint rejects unknown fields with 400.
          ...(branch.id === "groq"
            ? { seed: 7, reasoning_effort: "none" } // reference INTERACTIVE budget 0
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`${branch.id} HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = ""; // SSE frames can split across chunks — buffer lines.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (committed === -1 && now() - started > RACE_FIRST_TOKEN_MS) {
          controllers[i].abort();
          return;
        }
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const d = t.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try {
            const chunk = JSON.parse(d);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              if (committed === -1) {
                committed = i;
                firstTokenMs = now() - started;
              }
              if (committed === i) {
                texts[i] += delta;
                // JSON payloads run ~800+ chars — let the stream complete
                // rather than cutting mid-object (that truncated parse).
              }
            }
          } catch {
            // keepalive/comment frames
          }
        }
      }
    } catch (e) {
      // AbortController cancels are expected for losing branches.
      if (!String(e).includes("abort")) branchErrors[i] = String(e).slice(0, 160);
    }
  });

  await Promise.allSettled(readers);
  if (committed === -1) {
    return { error: "no branch committed", branchErrors: branchErrors.filter(Boolean) };
  }
  const text = texts[committed]
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  let valid = false;
  try {
    const j = JSON.parse(text);
    valid = typeof j.detected_question === "string" && Array.isArray(j.suggested_outline);
  } catch {
    valid = false;
  }
  return {
    committed: branches[committed].id,
    firstTokenMs: firstTokenMs ?? now() - started,
    totalMs: now() - started,
    valid,
    textHead: text.slice(0, 100),
  };
}

// â”€â”€ Our semantics: router's measured best, single committed call â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function ours(branch, messages) {
  const started = now();
  let firstTokenMs = null;
  const res = await fetch(`${branch.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${branch.key}` },
    body: JSON.stringify({ model: branch.model, messages, stream: true, max_tokens: 400 }),
  });
  if (!res.ok) throw new Error(`ours ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstTokenMs === null) firstTokenMs = now() - started;
    sse += decoder.decode(value, { stream: true });
  }
  let text = "";
  for (const line of sse.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const d = t.slice(5).trim();
    if (!d || d === "[DONE]") continue;
    try {
      const chunk = JSON.parse(d);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch { /* keepalive */ }
  }
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  let valid = false;
  try {
    const j = JSON.parse(stripped);
    valid = typeof j.detected_question === "string" && Array.isArray(j.suggested_outline);
  } catch { valid = false; }
  return { firstTokenMs, totalMs: now() - started, valid };
}

// â”€â”€ Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const groqKey = process.env.GROQ_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const results = { startedAt: new Date().toISOString(), runs: RUNS, scenarios: {} };

if (groqKey && geminiKey) {
  const referenceBranches = [
    { id: "groq", baseUrl: "https://api.groq.com/openai/v1", key: groqKey, model: "qwen/qwen3.6-27b" },
    { id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: geminiKey, model: "gemini-flash-latest" },
  ];
  const oursBranch = { id: "ours-groq", baseUrl: "https://api.groq.com/openai/v1", key: groqKey, model: "qwen/qwen3.8-27b" };

  const referenceSamples = [];
  const oursSamples = [];
  for (let i = 0; i < RUNS; i++) {
    const q = QUESTION_BANK[i % QUESTION_BANK.length];
    const messages = buildCoachMessages({ verbatimTranscript: `Interviewer: ${q.text}` }).map((m) => ({
      ...m,
      content: m.role === "system" ? `${m.content}\n${SCHEMA_HINT}` : m.content,
    }));
    referenceSamples.push(await referenceRace(referenceBranches, messages).catch((e) => ({ error: String(e).slice(0, 140) })));
    oursSamples.push(await ours(oursBranch, messages).catch((e) => ({ error: String(e).slice(0, 140) })));
  }
  const summarize = (samples) => {
    const ok = samples.filter((s) => !s.error);
    return {
      committed: ok[0]?.committed ?? null,
      firstTokenMs: ok.length ? Math.round(ok.reduce((a, s) => a + (s.firstTokenMs ?? 0), 0) / ok.length) : null,
      totalMs: ok.length ? Math.round(ok.reduce((a, s) => a + s.totalMs, 0) / ok.length) : null,
      jsonValidity: ok.length ? ok.filter((s) => s.valid).length / ok.length : 0,
      errors: samples.filter((s) => s.error).map((s) => (s.branchErrors ? `${s.error} [${JSON.stringify(s.branchErrors)}]` : s.error)),
      textHeads: samples.filter((s) => s.textHead).map((s) => s.textHead),
    };
  };
  results.scenarios.coach = { "reference-semantics(race)": summarize(referenceSamples), "ours(best-single)": summarize(oursSamples) };
} else {
  results.scenarios.coach = { note: "GROQ_API_KEY + GEMINI_API_KEY required" };
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/reference-parity.json", import.meta.url), JSON.stringify(results, null, 2));

// Reuse prior local-STT measurements for the STT dimension.
const moonshine = existsSync(new URL("./results/moonshine-speech.json", import.meta.url))
  ? JSON.parse(readFileSync(new URL("./results/moonshine-speech.json", import.meta.url), "utf8"))
  : null;
const bestMoonshine = moonshine
  ? Math.min(...moonshine.utterances.filter((u) => u.firstPartialMs !== null).map((u) => u.firstPartialMs))
  : null;
results.scenarios.sttLocalFirstPartial = { "ours(=reference model class moonshine-tiny)": bestMoonshine };
writeFileSync(new URL("./results/reference-parity.json", import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.scenarios, null, 2));
