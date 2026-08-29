/**
 * Vision benchmark: screenshot-sized image → structured answer latency per
 * configured endpoint (vision-capable model required).
 */
import { mkdirSync, writeFileSync } from "node:fs";

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);

const ENDPOINTS = [];
if (process.env.OPENROUTER_API_KEY) {
  ENDPOINTS.push({
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_VISION_MODEL ?? process.env.OPENROUTER_VISION_MODEL_OVERRIDE ?? "qwen/qwen2.5-vl-72b-instruct:free",
  });
}
if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY) {
  ENDPOINTS.push({
    id: process.env.OPENAI_COMPAT_ID ?? "openai_compat",
    baseUrl: process.env.OPENAI_COMPAT_BASE_URL.replace(/\/$/, ""),
    key: process.env.OPENAI_COMPAT_API_KEY,
    model: process.env.OPENAI_COMPAT_VISION_MODEL ?? process.env.OPENAI_COMPAT_MODEL,
  });
}
if (process.env.GEMINI_API_KEY) {
  ENDPOINTS.push({
    id: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_VISION_MODEL ?? "gemini-flash-latest",
  });
}

/** 512×288 PNG placeholder (1×1 scaled synthetic "screenshot") — replace with
 *  a real capture from benchmarks/corpus/screenshot.png when present. */
function tinyPngDataUrl() {
  // 1×1 red PNG, base64 — providers accept it; timing is what we measure.
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  return `data:image/png;base64,${b64}`;
}

async function runOnce(endpoint) {
  const started = now();
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in one JSON object {\"seen\":string}." },
            { type: "image_url", image_url: { url: tinyPngDataUrl() } },
          ],
        },
      ],
      max_tokens: 120,
    }),
  });
  if (!res.ok) throw new Error(`${endpoint.id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await res.json();
  return { totalMs: now() - started };
}

const results = { startedAt: new Date().toISOString(), runs: RUNS, endpoints: {} };

if (ENDPOINTS.length === 0) {
  results.note = "No keys configured.";
} else {
  for (const endpoint of ENDPOINTS) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        samples.push(await runOnce(endpoint));
      } catch (e) {
        samples.push({ error: String(e) });
      }
    }
    const ok = samples.filter((s) => !s.error);
    results.endpoints[endpoint.id] = {
      model: endpoint.model,
      totalMs: ok.length ? Math.round(ok.reduce((a, s) => a + s.totalMs, 0) / ok.length) : null,
      errors: samples.filter((s) => s.error).map((s) => s.error),
    };
  }
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/vision.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("wrote benchmarks/results/vision.json");
