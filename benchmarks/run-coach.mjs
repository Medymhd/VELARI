/**
 * Coach benchmark: §7 live-coach prompt per OpenAI-compatible endpoint.
 * Measures first-token latency (streaming), end-to-end latency, and JSON
 * validity rate. Endpoints: OpenRouter + any OPENAI_COMPAT_* gateway.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const { buildCoachMessages, QUESTION_BANK } = req("../verticals/interview-intelligence/dist/index.js");

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

const ENDPOINTS = [];
if (process.env.OPENROUTER_API_KEY) {
  const models = (process.env.OPENROUTER_MODELS ?? "openrouter/auto:free,meta-llama/llama-3.3-70b-instruct:free")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  models.forEach((model, i) => {
    ENDPOINTS.push({
      id: i === 0 ? "openrouter" : `openrouter_${model.replace(/[^a-z0-9]+/gi, "_")}`,
      baseUrl: "https://openrouter.ai/api/v1",
      key: process.env.OPENROUTER_API_KEY,
      model,
    });
  });
}
if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY) {
  const models = (process.env.OPENAI_COMPAT_MODELS ?? process.env.OPENAI_COMPAT_MODEL)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  models.forEach((model, i) => {
    ENDPOINTS.push({
      id: i === 0 ? (process.env.OPENAI_COMPAT_ID ?? "openai_compat") : `${process.env.OPENAI_COMPAT_ID ?? "openai_compat"}_${model.replace(/[^a-z0-9.]+/gi, "_")}`,
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL.replace(/\/$/, ""),
      key: process.env.OPENAI_COMPAT_API_KEY,
      model,
    });
  });
}

// Free-tier gateways. Defaults are $0 models only; override via env.
if (process.env.GROQ_API_KEY) {
  const models = (process.env.GROQ_MODELS ?? "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  models.forEach((model, i) => {
    ENDPOINTS.push({
      id: i === 0 ? "groq" : `groq_${model.replace(/[^a-z0-9.]+/gi, "_")}`,
      baseUrl: "https://api.groq.com/openai/v1",
      key: process.env.GROQ_API_KEY,
      model,
    });
  });
}
if (process.env.GEMINI_API_KEY) {
  const models = (process.env.GEMINI_MODELS ?? "gemini-flash-latest,gemini-2.5-flash-lite")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  models.forEach((model, i) => {
    ENDPOINTS.push({
      id: i === 0 ? "gemini" : `gemini_${model.replace(/[^a-z0-9.]+/gi, "_")}`,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: process.env.GEMINI_API_KEY,
      model,
    });
  });
}
if (process.env.ZHIPU_API_KEY) {
  ENDPOINTS.push({
    id: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    key: process.env.ZHIPU_API_KEY,
    model: process.env.ZHIPU_MODEL ?? "glm-5.3-flash",
  });
}
if (process.env.HUGGINGFACE_API_KEY) {
  ENDPOINTS.push({
    id: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    key: process.env.HUGGINGFACE_API_KEY,
    model: process.env.HF_MODEL ?? "meta-llama/Llama-3.1-8B-Instruct",
  });
}

const SCHEMA_HINT =
  'Respond ONLY with JSON {"detected_question":string,"suggested_outline":string[],"talking_points":string[],"confidence":number,"requires_user_review":boolean}';

async function runOnce(endpoint, messages) {
  const started = now();
  let firstTokenMs = null;
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({ model: endpoint.model, messages, stream: true, max_tokens: 800 }),
  });
  if (!res.ok) throw new Error(`${endpoint.id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstTokenMs === null) firstTokenMs = now() - started;
    sse += decoder.decode(value, { stream: true });
  }
  const totalMs = now() - started;

  // Proper SSE assembly: each data: frame carries a delta.
  let text = "";
  for (const line of sse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch {
      // provider keepalive/comment frames
    }
  }

  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
  let valid = false;
  try {
    const j = JSON.parse(stripped);
    valid = typeof j.detected_question === "string" && Array.isArray(j.suggested_outline);
  } catch {
    valid = false;
  }
  return { firstTokenMs, totalMs, valid };
}

const results = { startedAt: new Date().toISOString(), runs: RUNS, endpoints: {} };

if (ENDPOINTS.length === 0) {
  results.note = "No keys configured (OPENROUTER_API_KEY / OPENAI_COMPAT_*).";
} else {
  for (const endpoint of ENDPOINTS) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const q = QUESTION_BANK[i % QUESTION_BANK.length];
      const messages = buildCoachMessages({ verbatimTranscript: `Interviewer: ${q.text}` }).map((m) => ({
        ...m,
        content: m.role === "system" ? `${m.content}\n${SCHEMA_HINT}` : m.content,
      }));
      try {
        samples.push(await runOnce(endpoint, messages));
      } catch (e) {
        samples.push({ error: String(e) });
      }
    }
    const ok = samples.filter((s) => !s.error);
    results.endpoints[endpoint.id] = {
      model: endpoint.model,
      firstTokenMs: ok.length ? Math.round(ok.reduce((a, s) => a + s.firstTokenMs, 0) / ok.length) : null,
      totalMs: ok.length ? Math.round(ok.reduce((a, s) => a + s.totalMs, 0) / ok.length) : null,
      jsonValidity: ok.length ? ok.filter((s) => s.valid).length / ok.length : 0,
      errors: samples.filter((s) => s.error).map((s) => s.error),
    };
  }
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/coach.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("wrote benchmarks/results/coach.json");
