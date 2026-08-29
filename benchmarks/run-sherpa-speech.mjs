/**
 * Sherpa partial-latency on REAL speech (P1): feeds the SAPI-generated
 * corpus through our streaming engine and measures first-partial latency,
 * partial count, and final transcription quality.
 * Usage: node benchmarks/run-sherpa-speech.mjs   (model must be downloaded)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const { SherpaStreamingSttEngine } = req("../packages/ai-runtime/dist/index.js");

const CORPUS = new URL("./corpus/", import.meta.url);
const files = readdirSync(CORPUS).filter((f) => f.endsWith(".wav"));
if (files.length === 0) {
  console.error("no corpus — run benchmarks/make-corpus.ps1 first");
  process.exit(1);
}

/** Extract raw PCM16 from a RIFF/WAVE file (handles extra chunks). */
function pcmFromWav(buf) {
  let off = 12; // RIFF, size, WAVE
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
const FRAME_BYTES = 320 * 2; // 20 ms @16 kHz

const results = { startedAt: new Date().toISOString(), utterances: [] };

for (const file of files) {
  const pcm = pcmFromWav(readFileSync(new URL(file, CORPUS)));
  const engine = new SherpaStreamingSttEngine();
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

  const pacing = process.env.SHERPA_REALTIME_PACING === "1";
  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    engine.feed(pcm.subarray(off, off + FRAME_BYTES), now() - started, onResult);
    if (pacing) await sleep(19); // realtime cadence — live usage never outpaces the mic
    else if ((off / FRAME_BYTES) % 5 === 0) await sleep(1);
  }
  engine.flush(onResult);
  await sleep(2500); // decoder tail
  engine.close();

  const audioMs = Math.round((pcm.length / 2 / 16000) * 1000);
  results.utterances.push({
    file,
    audioMs,
    firstPartialMs,
    partials,
    finalText,
    realTimeFactor: Number(((now() - started) / audioMs).toFixed(2)),
  });
  console.log(`${file}: audio ${audioMs}ms, first partial ${firstPartialMs ?? "—"}ms, partials ${partials}, final: "${finalText.slice(0, 60)}"`);
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/sherpa-speech.json", import.meta.url), JSON.stringify(results, null, 2));
const withPartials = results.utterances.filter((u) => u.firstPartialMs !== null);
const best = withPartials.length ? Math.min(...withPartials.map((u) => u.firstPartialMs)) : null;
console.log(`\nfirst-partial best: ${best}ms (target <700ms) — wrote results/sherpa-speech.json`);
