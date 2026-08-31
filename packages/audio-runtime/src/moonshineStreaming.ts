/**
 * Moonshine streaming STT — the rival's local latency model class
 * (`moonshine-tiny` ONNX via transformers.js), MIT weights, fully offline.
 *
 * Moonshine is a non-streaming (segment) decoder, so partials come from
 * periodic re-decode of the accumulated buffer — the same pattern the rival's
 * `whisperWorker` uses. On CPU, decoding 2-4 s of audio lands in the
 * sub-second range, giving first partials far ahead of the zipformer's
 * ~3 s warmup.
 */
import type { SttEngine, SttPartial, SttFinal } from "./stt.js";

export interface MoonshinePipeline {
  (audio: Float32Array, opts?: Record<string, unknown>): Promise<{ text?: string }>;
}

export type MoonshineFactory = () => Promise<MoonshinePipeline>;

export const DEFAULT_MOONSHINE_MODEL = "onnx-community/moonshine-tiny-ONNX";

export interface MoonshineEngineOptions {
  /** Inject the ASR pipeline (tests); default loads transformers.js lazily. */
  factory?: MoonshineFactory;
  model?: string;
  /** ONNX quantization: "q8" | "q4" | "fp16" | "fp32" (model repo must ship it). */
  dtype?: string;
  /** Re-decode cadence: partials refresh every N ms of NEW audio. */
  partialEveryMs?: number;
  sampleRate?: number;
}

/** transformers.js loader — kept lazy so the dep stays optional. */
export function defaultMoonshineFactory(model: string, dtype: string): MoonshineFactory {
  return async () => {
    const { pipeline } = (await import("@huggingface/transformers")) as unknown as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<MoonshinePipeline>;
    };
    return pipeline("automatic-speech-recognition", model, { dtype });
  };
}

export class MoonshineStreamingSttEngine implements SttEngine {
  readonly source = "local_stt" as const;

  private readonly factory: MoonshineFactory;
  private readonly partialEveryMs: number;
  private readonly sampleRate: number;

  private pipeline: MoonshinePipeline | null = null;
  private initPromise: Promise<boolean> | null = null;
  private unavailableFired = false;
  private unavailableCb: (() => void) | null = null;
  private onResult: ((r: SttPartial | SttFinal) => void) | null = null;

  private buffer: Float32Array = new Float32Array(0);
  private decodedThroughMs = 0; // audio duration already decoded
  private lastPartial = "";
  private decodeInFlight = false;
  private lastLoudAtMs = 0;
  private dbgDecodeCount = 0;
  private dbgFed = false;
  private dbgFeedCount = 0;
  private dbgGated = false;
  private dbgDecoded = false;
  private dbgStartMs = Date.now();
  private decodeQueued = false;
  private finalPending = false;
  private audioStartMs = 0;
  private lastFeedAtMs = 0;
  private closed = false;

  constructor(opts: MoonshineEngineOptions = {}) {
    const model = opts.model ?? process.env.MOONSHINE_MODEL ?? DEFAULT_MOONSHINE_MODEL;
    const dtype = opts.dtype ?? process.env.MOONSHINE_DTYPE ?? "q8";
    this.factory = opts.factory ?? (() => defaultMoonshineFactory(model, dtype)());
    this.partialEveryMs = opts.partialEveryMs ?? 400;
    this.sampleRate = opts.sampleRate ?? 16_000;
  }

  onUnavailable(cb: () => void): void {
    this.unavailableCb = cb;
  }

  close(): void {
    this.closed = true;
    this.pipeline = null;
    this.buffer = new Float32Array(0);
    this.initPromise = null;
  }

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    if (this.closed) return;
    this.onResult = onResult;
    if (this.audioStartMs === 0 || atMs < this.audioStartMs) this.audioStartMs = atMs;
    this.lastFeedAtMs = atMs;

    const samples = new Float32Array(pcm.length >> 1);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768;
      sum += samples[i]! * samples[i]!;
    }
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;

    // Track the last loud chunk — the decode gate drops only buffers with no
    // speech since utterance start, never a buffer holding real speech.
    const chunkRms = Math.sqrt(sum / Math.max(1, samples.length));
    if (chunkRms > MOONSHINE_SILENCE_RMS) this.lastLoudAtMs = atMs;

    if (process.env.MOONSHINE_DEBUG === "1" && !this.dbgFed) {
      this.dbgFed = true;
      console.log(`[moonshine:dbg] first feed: samples=${samples.length} rms=${chunkRms.toFixed(5)}`);
    } else if (process.env.MOONSHINE_DEBUG === "1" && this.dbgFeedCount < 3) {
      this.dbgFeedCount += 1;
      console.log(`[moonshine:dbg] feed #${this.dbgFeedCount + 1}: bufferMs=${Math.round((this.buffer.length / this.sampleRate) * 1000)}`);
    }
    const audioMs = (this.buffer.length / this.sampleRate) * 1000;
    // Skip tiny buffers — Moonshine needs ~0.4 s of audio for a stable read.
    if (audioMs >= 400 && audioMs - this.decodedThroughMs >= this.partialEveryMs && !this.decodeInFlight) {
      void this.decode(false);
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    this.onResult = (r) => {
      if (r.isFinal) onResult(r);
    };
    if (this.buffer.length === 0) return;
    // Snapshot and OWN the buffer synchronously — the disconnect sequence is
    // flush() followed immediately by close(), and close() wipes state. The
    // final decode runs from this private copy and ignores `closed`.
    const audio = trimTrailingSilence(this.buffer);
    const startedAtMs = this.audioStartMs;
    const endedAtMs = Math.max(this.lastFeedAtMs, this.audioStartMs + 200);
    this.buffer = new Float32Array(0);
    this.decodedThroughMs = 0;
    this.lastPartial = "";
    this.audioStartMs = 0;
    void (async () => {
      try {
        if (audio.length === 0 || !(await this.init()) || !this.pipeline) return;
        const out = await this.pipeline(audio, { sampling_rate: this.sampleRate });
        const text = collapseRepetition((out?.text ?? "").trim());
        if (text) this.onResult?.({ isFinal: true, text, confidence: 0.85, startedAtMs, endedAtMs });
      } catch (e) {
        console.warn(`[moonshine] flush decode failed: ${String(e).slice(0, 160)}`);
      }
    })();
  }

  private async init(): Promise<boolean> {
    if (this.pipeline) return true;
    if (this.unavailableFired) return false;
    if (!this.initPromise) {
      // First load may fetch weights from the HF hub; a stalled network must
      // degrade to the next rung instead of stalling the whole chain.
      const INIT_TIMEOUT_MS = 10_000;
      this.initPromise = Promise.race([
        this.factory()
          .then(async (p) => {
            this.pipeline = p;
            // Warmup decode: pays session/model init off the first-utterance path.
            try {
              await p(new Float32Array(this.sampleRate), { sampling_rate: this.sampleRate });
            } catch {
              // warmup is best-effort
            }
            return true;
          }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`moonshine init exceeded ${INIT_TIMEOUT_MS}ms`)), INIT_TIMEOUT_MS),
        ),
      ])
        .catch((e) => {
          console.warn(`[moonshine] unavailable: ${String(e).slice(0, 160)}`);
          this.unavailableFired = true;
          this.unavailableCb?.();
          return false;
        });
    }
    return this.initPromise;
  }

  private async decode(final: boolean): Promise<void> {
    if (this.decodeInFlight) {
      // A partial can coalesce into the in-flight decode; a FINAL must never
      // be dropped — it re-runs as soon as the in-flight decode settles.
      if (!final) this.decodeQueued = true;
      else this.finalPending = true;
      return;
    }
    if (this.buffer.length === 0) return;
    this.decodeInFlight = true;
    const raw = this.buffer;
    try {
      if (!(await this.init()) || !this.pipeline) return;
      if (this.closed) return;
      // Trim trailing silence: inference on a silent tail wastes CPU, and the
      // whole-buffer RMS gate would misread speech+silence mixtures as silence
      // and drop real speech.
      const audio = trimTrailingSilence(raw);
      if (audio.length === 0) {
        // Pure silence since utterance start — drop the buffer entirely.
        this.buffer = new Float32Array(0);
        this.decodedThroughMs = 0;
        this.lastPartial = "";
        this.audioStartMs = 0;
        return;
      }
      let energy = 0;
      for (let i = 0; i < audio.length; i++) energy += audio[i]! * audio[i]!;
      const rms = Math.sqrt(energy / Math.max(1, audio.length));
      if (process.env.MOONSHINE_DEBUG === "1" && this.dbgDecodeCount < 5) {
        this.dbgDecodeCount += 1;
        console.log(`[moonshine:dbg] decode #${this.dbgDecodeCount}: trimmedMs=${Math.round((audio.length / this.sampleRate) * 1000)} rms=${rms.toFixed(5)} final=${final}`);
      }
      if (rms < MOONSHINE_SILENCE_RMS) {
        // Mixed buffer too quiet to decode — keep it, wait for loud audio.
        return;
      }
      const out = await this.pipeline(audio, { sampling_rate: this.sampleRate });
      const text = collapseRepetition((out?.text ?? "").trim());
      if (process.env.MOONSHINE_DEBUG === "1" && !this.dbgDecoded) {
        this.dbgDecoded = true;
        console.log(`[moonshine:dbg] first decode: ${Date.now() - this.dbgStartMs}ms after first feed, text=${JSON.stringify(text.slice(0, 60))}`);
      }
      const startedAtMs = this.audioStartMs;
      const endedAtMs = Math.max(this.lastFeedAtMs, startedAtMs + 200);
      if (final) {
        if (text) this.onResult?.({ isFinal: true, text, confidence: 0.85, startedAtMs, endedAtMs });
        this.buffer = new Float32Array(0);
        this.decodedThroughMs = 0;
        this.lastPartial = "";
        this.audioStartMs = 0;
      } else if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.decodedThroughMs = (raw.length / this.sampleRate) * 1000;
        this.onResult?.({ isFinal: false, text, confidence: 0.7 });
      }
    } catch (e) {
      console.warn(`[moonshine] decode failed: ${String(e).slice(0, 160)}`);
    } finally {
      this.decodeInFlight = false;
      if (this.finalPending) {
        this.finalPending = false;
        void this.decode(true);
      } else if (this.decodeQueued && !final && this.buffer.length > 0) {
        this.decodeQueued = false;
        void this.decode(false);
      }
    }
  }
}

/** Below this whole-buffer RMS (float −1..1; ≈130 int16) audio is silence. */
const MOONSHINE_SILENCE_RMS = 0.004;
/** Per-sample amplitude below which tail samples count as trailing silence. */
const TRIM_AMPLITUDE = 0.002;

/** Cut trailing silence (±TRIM_AMPLITUDE) from a Float32 audio buffer.
 *  Returns an empty buffer when the input is entirely silent. */
function trimTrailingSilence(audio: Float32Array): Float32Array {
  let end = audio.length;
  while (end > 0 && Math.abs(audio[end - 1]!) < TRIM_AMPLITUDE) end -= 1;
  if (end === 0) return new Float32Array(0);
  return audio.slice(0, end);
}

/** Moonshine hallucination guard: collapse exact text doubling and runs of
 *  duplicated sentences that its silent-buffer decoding produces. */
function collapseRepetition(text: string): string {
  const t = text.trim();
  if (t.length >= 8 && t.length % 2 === 0) {
    const h = t.length / 2;
    if (t.slice(0, h) === t.slice(h)) return t.slice(0, h).trim();
  }
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    if (kept.length > 0 && kept[kept.length - 1] === s) continue;
    kept.push(s);
  }
  return kept.join(" ");
}


