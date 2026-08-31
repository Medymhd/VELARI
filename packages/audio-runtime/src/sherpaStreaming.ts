/**
 * Local streaming STT — sherpa-onnx Zipformer (reference `LocalWhisperSTT` parity,
 * upgraded to TRUE streaming partials like Deepgram's live socket).
 *
 * Runs fully offline via sherpa-onnx-node's prebuilt native bindings. The
 * model (small streaming Zipformer, ~17 MB) is fetched on first use if
 * missing. Init failures fire `onUnavailable` so the fallback chain degrades
 * to REST/simulated instead of breaking the session.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SttEngine, SttPartial, SttFinal } from "./stt.js";

export interface SherpaOnlineStream {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}

export interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): { text?: string; result_text?: string };
  isEndpoint(stream: SherpaOnlineStream): boolean;
  reset(stream: SherpaOnlineStream): void;
}

export type SherpaModule = { OnlineRecognizer: new (config: unknown) => SherpaOnlineRecognizer };

export const DEFAULT_SHERPA_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2";

function loadSherpaModule(): SherpaModule {
  const req = createRequire(import.meta.url);
  return req("sherpa-onnx-node") as SherpaModule;
}

/** Recursively locate tokens.txt + encoder .onnx under `dir`. */
function findModelFiles(dir: string): { tokens: string; encoder: string; decoder: string; joiner: string } | null {
  if (!existsSync(dir)) return null;
  let tokens: string | null = null;
  const onnx: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "tokens.txt") tokens = p;
      else if (entry.name.startsWith("encoder") && entry.name.endsWith(".onnx")) onnx.push(p);
    }
  };
  walk(dir);
  if (!tokens) return null;
  const encoder = onnx.find((p) => p.includes("int8")) ?? onnx[0]; // int8: faster CPU inference
  if (!encoder) return null;
  const base = path.basename(encoder);
  return {
    tokens,
    encoder,
    decoder: path.join(path.dirname(encoder), base.replace("encoder", "decoder")),
    joiner: path.join(path.dirname(encoder), base.replace("encoder", "joiner")),
  };
}

export function sherpaModelAvailable(modelDir?: string): boolean {
  return findModelFiles(modelDir ?? defaultModelDir()) !== null;
}

function defaultModelDir(): string {
  // Walk up from cwd so apps/api, packages/* and repo-root runs all resolve.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "models", "sherpa");
    if (existsSync(path.join(candidate, "tokens.txt"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "models", "sherpa");
}

/** Download + extract the model if `tokens.txt` is absent. Returns the dir. */
export async function ensureSherpaModel(
  modelDir: string,
  opts: { modelUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  if (findModelFiles(modelDir)) return modelDir;
  const url = opts.modelUrl ?? DEFAULT_SHERPA_MODEL_URL;
  mkdirSync(modelDir, { recursive: true });
  const archive = path.join(modelDir, "model.tar.bz2");
  console.log(`[sherpa] downloading model: ${url}`);
  const res = await (opts.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`sherpa model download failed: HTTP ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // bsdtar (Windows 10+) and GNU tar with bzip2 both handle .tar.bz2.
  execFileSync("tar", ["-xf", archive, "-C", modelDir]);
  rmSync(archive, { force: true });
  if (!findModelFiles(modelDir)) throw new Error(`sherpa model extracted but tokens.txt not found under ${modelDir}`);
  console.log(`[sherpa] model ready: ${modelDir}`);
  return modelDir;
}

export interface SherpaEngineOptions {
  modelDir?: string;
  modelUrl?: string;
  /** Inject the sherpa-onnx module (tests). */
  loadModule?: () => SherpaModule;
  sampleRate?: number;
  /** ONNX quantization: "q8" (default, fastest CPU) | "fp32" (best accuracy). */
  dtype?: string;
  /** Number of CPU threads for the recognizer (default 4). */
  numThreads?: number;
}

export class SherpaStreamingSttEngine implements SttEngine {
  readonly source = "local_stt" as const;

  private readonly modelDir: string;
  private readonly modelUrl: string | undefined;
  private readonly loadModule: () => SherpaModule;
  private readonly injected: boolean;
  private readonly sampleRate: number;

  private recognizer: SherpaOnlineRecognizer | null = null;
  private stream: SherpaOnlineStream | null = null;
  private unavailableFired = false;
  private unavailableCb: (() => void) | null = null;
  private onResult: ((r: SttPartial | SttFinal) => void) | null = null;
  private lastPartial = "";
  /** Last known non-empty text (partial or final) — flush fallback when
   *  getResult() returns empty after a reset (endpoint fired during feed). */
  private lastKnownText = "";
  private utteranceStartedAtMs = 0;
  private lastFeedAtMs = 0;
  /** Watchdog: some environments (server WS handlers) yield a recognizer that
   *  constructs fine but decodes empty — without this guard the fallback
   *  chain would hang on it forever since a silent decoder never fires
   *  onUnavailable. After 8s of fed audio with zero output, release the chain. */
  private fedSamples = 0;
  private firstFeedMs = 0;
  private emittedAny = false;
  /** Decode cadence: sherpa decodes in ~50ms feature windows for faster partials. */
  private pendingSamples: number[] = [];

  constructor(opts: SherpaEngineOptions = {}) {
    this.modelDir = opts.modelDir ?? process.env.SHERPA_MODEL_DIR ?? defaultModelDir();
    this.modelUrl = opts.modelUrl;
    this.loadModule = opts.loadModule ?? loadSherpaModule;
    this.injected = opts.loadModule !== undefined;
    this.sampleRate = opts.sampleRate ?? 16_000;
    this.numThreads = opts.numThreads ?? 4;
  }

  private readonly numThreads: number;

  onUnavailable(cb: () => void): void {
    this.unavailableCb = cb;
  }

  close(): void {
    this.recognizer = null;
    this.stream = null;
    this.pendingSamples = [];
  }

  /** SHERPA_MODEL_DIR is often relative ("models/sherpa") while the API runs
   *  with cwd=apps/api — walk up parent dirs until the model is found. */
  private resolveModelDir(): string {
    if (findModelFiles(this.modelDir)) return this.modelDir;
    if (!path.isAbsolute(this.modelDir)) {
      let cur = process.cwd();
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(cur, this.modelDir);
        if (findModelFiles(candidate)) {
          console.log(`[sherpa] model resolved via walk-up: ${candidate}`);
          return candidate;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    return this.modelDir;
  }

  private init(): boolean {
    if (this.recognizer) return true;
    if (this.unavailableFired) return false;
    try {
      // Injected modules (tests) get placeholder paths; the real loader
      // requires the on-disk model.
      const dir = this.resolveModelDir();
      const files = findModelFiles(dir);
      if (!files && !this.injected) {
        throw new Error(
          `sherpa model not found (searched "${this.modelDir}" from ${process.cwd()} and parents) — call ensureSherpaModel() or set SHERPA_MODEL_DIR`,
        );
      }
      const resolved =
        files ??
        {
          tokens: path.join(dir, "tokens.txt"),
          encoder: path.join(dir, "encoder.onnx"),
          decoder: path.join(dir, "decoder.onnx"),
          joiner: path.join(dir, "joiner.onnx"),
        };
      const { OnlineRecognizer } = this.loadModule();
      this.recognizer = new OnlineRecognizer({
        modelConfig: {
          transducer: { encoder: resolved.encoder, decoder: resolved.decoder, joiner: resolved.joiner },
          tokens: resolved.tokens,
          numThreads: this.numThreads,
          sampleRate: this.sampleRate,
          featureDim: 80,
        },
      });
      this.stream = this.recognizer.createStream();
      return true;
    } catch (e) {
      console.warn(`[sherpa] unavailable: ${String(e)}`);
      this.unavailableFired = true;
      this.unavailableCb?.();
      return false;
    }
  }

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    this.onResult = onResult;
    if (!this.init() || !this.recognizer || !this.stream) return;

    if (this.firstFeedMs === 0) this.firstFeedMs = atMs;
    this.fedSamples += pcm.length >> 1;
    // Watchdog: 8s of audio (128k samples @16k) with no output = dead decoder.
    // Sample-count based — wall-clock spans lie when feeds arrive bursted.
    if (!this.emittedAny && !this.unavailableFired && this.fedSamples >= this.sampleRate * 8) {
      console.warn("[sherpa] watchdog: no output after 8s of fed audio — releasing to fallback chain");
      this.unavailableFired = true;
      this.unavailableCb?.();
      return;
    }

    if (atMs < this.lastFeedAtMs || this.utteranceStartedAtMs === 0) this.utteranceStartedAtMs = atMs;
    this.lastFeedAtMs = atMs;

    // Int16 LE → Float32 [-1, 1)
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      this.pendingSamples.push(pcm.readInt16LE(i) / 32768);
    }
    // Decode in ~50 ms windows (800 samples) for 2× faster partial arreference.
    const WINDOW = this.sampleRate / 20;
    while (this.pendingSamples.length >= WINDOW) {
      const samples = new Float32Array(this.pendingSamples.splice(0, WINDOW));
      this.stream.acceptWaveform({ sampleRate: this.sampleRate, samples });
      this.decodeCurrent();
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    this.onResult = (r) => {
      if (r.isFinal) onResult(r);
    };
    if (!this.recognizer || !this.stream) return;

    if (this.pendingSamples.length > 0) {
      const samples = new Float32Array(this.pendingSamples.splice(0));
      this.stream.acceptWaveform({ sampleRate: this.sampleRate, samples });
    }
    // Flush with 1.5 s trailing silence — enough for the zipformer's
    // endpointing rule to fire and for the decoder to converge on tail words.
    const tail = new Float32Array(Math.floor(this.sampleRate * 1.5));
    this.stream.acceptWaveform({ sampleRate: this.sampleRate, samples: tail });
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);

    const raw = this.recognizer.getResult(this.stream);
    const trimmed = (raw?.text ?? raw?.result_text ?? "").trim();
    // Fall back to the last known partial when getResult() returns empty —
    // this happens when the recognizer state was reset by an endpoint event
    // during feed, or when the model decoded through all windows already.
    const finalText = trimmed || this.lastKnownText;
    this.resetStream();
    if (finalText) {
      const startedAtMs = this.utteranceStartedAtMs || this.lastFeedAtMs;
      this.utteranceStartedAtMs = 0;
      this.emittedAny = true;
      onResult({
        isFinal: true,
        text: finalText,
        confidence: 0.85,
        startedAtMs,
        endedAtMs: Math.max(this.lastFeedAtMs, startedAtMs + 200),
      });
    }
    this.lastPartial = "";
    this.lastKnownText = "";
  }

  private decodeCurrent(): void {
    if (!this.recognizer || !this.stream) return;
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);

    const raw = this.recognizer.getResult(this.stream) as { text?: string; result_text?: string } | undefined;
    const text = (raw?.text ?? raw?.result_text ?? "").trim();
    if (this.recognizer.isEndpoint(this.stream)) {
    if (text && this.onResult) {
      const startedAtMs = this.utteranceStartedAtMs || this.lastFeedAtMs;
      this.lastKnownText = text;
      this.emittedAny = true;
      this.onResult({
        isFinal: true,
        text,
        confidence: 0.85,
        startedAtMs,
        endedAtMs: Math.max(this.lastFeedAtMs, startedAtMs + 200),
      });
    }
    this.resetStream();
    return;
    }
    if (text && text !== this.lastPartial && this.onResult) {
      this.lastPartial = text;
      this.lastKnownText = text;
      this.emittedAny = true;
      this.onResult({ isFinal: false, text, confidence: 0.7 });
    }
  }

  private resetStream(): void {
    if (!this.recognizer || !this.stream) return;
    try {
      this.recognizer.reset(this.stream);
    } catch {
      // some builds replace the stream instead of resetting in place
      this.stream = this.recognizer.createStream();
    }
    this.lastPartial = "";
  }
}
