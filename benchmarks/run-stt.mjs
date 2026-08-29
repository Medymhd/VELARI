/**
 * STT benchmark: synthetic corpus through our engine chain.
 * Measures partial arrival, final latency, and harness correctness.
 * Requires DEEPGRAM_API_KEY for real providers; runs the simulated chain
 * otherwise (still validates the timing harness).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { session, toBuffers } from "./lib/corpus.mjs";

const req = createRequire(import.meta.url);
const {
  DeepgramStreamingSttEngine,
  DeepgramSttEngine,
  SimulatedSttEngine,
  LocalWhisperSttEngine,
  SherpaStreamingSttEngine,
  sherpaModelAvailable,
} = req("../packages/ai-runtime/dist/index.js");

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function benchStreaming(apiKey) {
  const engine = new DeepgramStreamingSttEngine(apiKey);
  const chunks = toBuffers(session());
  const startedAt = now();
  const partials = [];
  const finals = [];

  const onResult = (r) => {
    const atMs = now() - startedAt;
    if (r.isFinal) finals.push({ atMs, text: r.text });
    else partials.push({ atMs });
  };

  for (const [i, chunk] of chunks.entries()) {
    engine.feed(chunk, startedAt + i * 20, onResult); // 20ms frame cadence
    if (i % 50 === 0) await sleep(1); // yield like the DSP loop
  }
  engine.flush(onResult);
  await sleep(15_000); // allow in-flight finals to land
  engine.close();

  return {
    partialCount: partials.length,
    finalCount: finals.length,
    firstPartialMs: partials[0]?.atMs ?? null,
    firstFinalMs: finals[0]?.atMs ?? null,
    lastFinalMs: finals.at(-1)?.atMs ?? null,
    sampleFinalText: finals[0]?.text ?? null,
  };
}

async function benchRest(apiKey) {
  const engine = new DeepgramSttEngine(apiKey);
  // REST path buffers via feed, transcribes on flush.
  const chunks = toBuffers(session());
  const started = now();
  const final = await new Promise((resolve) => {
    chunks.forEach((c, i) => engine.feed(c, started + i * 20, () => {}));
    engine.flush(resolve);
  });
  return { totalMs: now() - started, textLen: final?.text?.length ?? 0 };
}

// Groq hosts whisper-large-v3-turbo free — measures OUR LocalWhisperSttEngine
// (OpenAI-compatible transcription server) end-to-end: WAV wrap + multipart.
async function benchGroqWhisper(apiKey) {
  const wrapped = new LocalWhisperSttEngine("https://api.groq.com/openai/v1", "whisper-large-v3-turbo", (async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${apiKey}`);
    return fetch(url, { ...init, headers });
  }));
  const chunks = toBuffers(session());
  const started = now();
  const final = await new Promise((resolve, reject) => {
    chunks.forEach((c, i) => wrapped.feed(c, started + i * 20, () => {}));
    wrapped.flush(resolve);
    setTimeout(() => reject(new Error("groq whisper timeout 30s")), 30_000);
  });
  return { totalMs: now() - started, textLen: final?.text?.length ?? 0, text: final?.text ?? null };
}

// Local streaming partials: sherpa-onnx Zipformer (offline, free).
async function benchSherpa() {
  const engine = new SherpaStreamingSttEngine();
  const chunks = toBuffers(session());
  const startedAt = now();
  const partials = [];
  const finals = [];
  const onResult = (r) => {
    const atMs = now() - startedAt;
    if (r.isFinal) finals.push({ atMs, text: r.text });
    else partials.push({ atMs });
  };
  for (const [i, chunk] of chunks.entries()) {
    engine.feed(chunk, startedAt + i * 20, onResult); // 20ms frame cadence
    if (i % 25 === 0) await sleep(1);
  }
  engine.flush(onResult);
  engine.close();
  return {
    partialCount: partials.length,
    finalCount: finals.length,
    firstPartialMs: partials[0]?.atMs ?? null,
    firstFinalMs: finals[0]?.atMs ?? null,
    lastFinalMs: finals.at(-1)?.atMs ?? null,
  };
}

const results = { startedAt: new Date().toISOString(), providers: {} };

const deepgramKey = process.env.DEEPGRAM_API_KEY;
if (deepgramKey) {
  try {
    results.providers.deepgram_streaming = await benchStreaming(deepgramKey);
  } catch (e) {
    results.providers.deepgram_streaming = { error: String(e) };
  }
  try {
    results.providers.deepgram_rest = await benchRest(deepgramKey);
  } catch (e) {
    results.providers.deepgram_rest = { error: String(e) };
  }
} else {
  results.providers.note = "DEEPGRAM_API_KEY not set — deepgram scenarios skipped";
}

const groqKey = process.env.GROQ_API_KEY;
if (groqKey) {
  try {
    results.providers.groq_whisper_turbo = await benchGroqWhisper(groqKey);
  } catch (e) {
    results.providers.groq_whisper_turbo = { error: String(e).slice(0, 200) };
  }
}

if (sherpaModelAvailable()) {
  try {
    results.providers.sherpa_zipformer_local = await benchSherpa();
  } catch (e) {
    results.providers.sherpa_zipformer_local = { error: String(e).slice(0, 200) };
  }
} else {
  results.providers.sherpa_note = "model not downloaded — run ensureSherpaModel('models/sherpa')";
}

// Baseline: simulated chain (harness sanity, zero network).
{
  const engine = new SimulatedSttEngine();
  const chunks = toBuffers(session());
  const started = now();
  let finals = 0;
  chunks.forEach((c, i) => engine.feed(c, started + i * 20, (r) => (r.isFinal ? finals++ : 0)));
  results.providers.simulated = { totalMs: now() - started, finals };
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/stt.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("wrote benchmarks/results/stt.json");
