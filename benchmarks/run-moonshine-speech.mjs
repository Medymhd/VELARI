/**
 * Moonshine partial-latency on REAL speech (P1): SAPI corpus through our
 * MoonshineStreamingSttEngine. Model downloads on first run (~50 MB, MIT).
 * Usage: node benchmarks/run-moonshine-speech.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const { MoonshineStreamingSttEngine } = req("../packages/audio-runtime/dist/index.js");

// DTYPE env switches quantization: q8 (default) | q4 | fp16 | fp32.
const DTYPE = process.env.MOONSHINE_DTYPE ?? "q8";

const CORPUS = new URL("./corpus/", import.meta.url);
const files = readdirSync(CORPUS).filter((f) => f.endsWith(".wav"));
if (files.length === 0) {
  console.error("no corpus — run benchmarks/make-corpus.ps1 first");
  process.exit(1);
}

function pcmFromWav(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("data chunk not found");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const FRAME_BYTES = 320 * 2;

const results = { startedAt: new Date().toISOString(), dtype: DTYPE, utterances: [] };

for (const file of files) {
  const pcm = pcmFromWav(readFileSync(new URL(file, CORPUS)));
  const engine = new MoonshineStreamingSttEngine({ partialEveryMs: 400, dtype: DTYPE });
  const started = now();
  let firstPartialMs = null;
  let partials = 0;
  let finalText = "";

  const onResult = (r) => {
    if (r.isFinal) finalText = r.text;
    else {
      partials += 1;
      if (firstPartialMs === null) firstPartialMs = now() - started;
    }
  };

  // Realtime pacing — mirrors live usage (mic never outpaces realtime).
  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    engine.feed(pcm.subarray(off, off + FRAME_BYTES), now() - started, onResult);
    await sleep(19);
  }
  engine.flush(onResult);
  await sleep(5000); // allow decode tail (first run may include model load)
  engine.close();

  const audioMs = Math.round((pcm.length / 2 / 16000) * 1000);
  const utt = {
    file,
    audioMs,
    firstPartialMs,
    partials,
    finalText,
    realTimeFactor: Number(((now() - started) / audioMs).toFixed(2)),
  };
  results.utterances.push(utt);
  console.log(`${file}: audio ${audioMs}ms, first partial ${firstPartialMs ?? "—"}ms, partials ${partials}, final: "${finalText.slice(0, 70)}"`);
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/moonshine-speech.json", import.meta.url), JSON.stringify(results, null, 2));
const withPartials = results.utterances.filter((u) => u.firstPartialMs !== null);
const best = withPartials.length ? Math.min(...withPartials.map((u) => u.firstPartialMs)) : null;
console.log(`\nfirst-partial best: ${best}ms (target <700ms) — wrote results/moonshine-speech.json`);
