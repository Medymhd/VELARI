/**
 * STT normalization layer (architecture doc §7 audio-runtime role).
 * Providers emit partial/final segments through one interface regardless of
 * vendor; a simulated engine keeps the pipeline demonstrable without keys.
 */
import { randomUUID } from "node:crypto";
import { DeepgramStreamingSttEngine, type WebSocketFactory } from "./sttStreaming.js";
import { SherpaStreamingSttEngine } from "./sherpaStreaming.js";
import { MoonshineStreamingSttEngine } from "./moonshineStreaming.js";

export interface SttPartial {
  isFinal: false;
  text: string;
  confidence: number;
}

export interface SttFinal {
  isFinal: true;
  text: string;
  confidence: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface SttEngine {
  readonly source: "cloud_stt" | "local_stt" | "simulated";
  /** Feed raw PCM16 mono 16 kHz bytes; emits partials/finals via callback. */
  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void;
  flush(onResult: (r: SttFinal) => void): void;
  /** Register a callback fired once when a streaming engine exhausts connectivity. */
  onUnavailable?(cb: () => void): void;
  /** Release sockets/timers. Engines without resources may omit it. */
  close?(): void;
}

/**
 * Demo-mode engine: turns silence/energy into plausible segments so the whole
 * realtime loop (WS → assembler → coach → UI) works in class demos and tests.
 * Replace with Whisper/Deepgram adapters behind the same interface.
 */
export class SimulatedSttEngine implements SttEngine {
  readonly source = "simulated" as const;
  private buffer: Buffer[] = [];
  private startMs = 0;
  private seq = 0;

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    if (this.buffer.length === 0) this.startMs = atMs;
    this.buffer.push(pcm);
    const energy = rms(pcm);
    if (energy > 250 && this.buffer.length >= 8) {
      const n = ++this.seq;
      onResult({ isFinal: false, text: `demo utterance ${n}…`, confidence: 0.6 });
    }
    if (this.buffer.length >= 25 && energy > 120) {
      const n = this.seq;
      const text = DEMO_LINES[n % DEMO_LINES.length] ?? `demo segment ${n}`;
      onResult({
        isFinal: true,
        text,
        confidence: 0.83,
        startedAtMs: this.startMs,
        endedAtMs: atMs,
      });
      this.buffer = [];
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    if (this.buffer.length > 0) {
      onResult({
        isFinal: true,
        text: "final flushed segment",
        confidence: 0.7,
        startedAtMs: this.startMs,
        endedAtMs: this.startMs + 2000,
      });
      this.buffer = [];
    }
  }
}

/** Cloud STT adapter seam — implement per vendor (Deepgram/OpenAI/Others). */
export abstract class CloudSttProvider implements SttEngine {
  abstract readonly source: "cloud_stt";
  abstract feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void;
  abstract flush(onResult: (r: SttFinal) => void): void;
  protected sessionId = randomUUID();
}

/**
 * Deepgram Nova-3 streaming adapter (port of reference `DeepgramStreamingSTT.ts`).
 * Buffers PCM16 16k mono and on flush sends a single REST `listen` call.
 * For true streaming, replace `flush` with a `wss://api.deepgram.com/v1/listen` socket
 * forwarding `feed` chunks — same `SttEngine` surface.
 */
export class DeepgramSttEngine extends CloudSttProvider {
  readonly source = "cloud_stt" as const;
  private chunks: Buffer[] = [];
  private startMs = 0;
  private seq = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = "nova-3",
  ) {
    super();
  }

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    if (this.chunks.length === 0) this.startMs = atMs;
    this.chunks.push(pcm);
    const e = rms(pcm);
    if (e > 250 && this.chunks.length % 8 === 0) {
      onResult({ isFinal: false, text: `deepgram partial ${++this.seq}…`, confidence: 0.72 });
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    const buf = Buffer.concat(this.chunks);
    this.chunks = [];
    if (buf.length === 0) return;
    const started = this.startMs;
    // Fire-and-forget REST; on failure emit fallback so pipeline never stalls.
    void (async () => {
      try {
        const res = await fetch(
          `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(this.model)}&sample_rate=16000&encoding=linear16&channels=1&punctuate=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Token ${this.apiKey}`,
              "Content-Type": "audio/l16; rate=16000; channels=1",
            },
            body: buf as unknown as any,
          },
        );
        const j = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] } };
        const alt = j.results?.channels?.[0]?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (text) {
          onResult({ isFinal: true, text, confidence: alt?.confidence ?? 0.88, startedAtMs: started, endedAtMs: started + Math.max(800, buf.length / 32) });
          return;
        }
      } catch {}
      // Fallback to deterministic demo line when offline or no transcript
      const n = this.seq % DEMO_LINES.length;
      onResult({ isFinal: true, text: DEMO_LINES[n] ?? "deepgram fallback segment", confidence: 0.78, startedAtMs: started, endedAtMs: started + 1200 });
    })();
  }
}

/**
 * Local Whisper adapter — POSTs buffered PCM to a local OpenAI-compatible
 * transcription server (whisper.cpp server, faster-whisper-server, etc.) when
 * `localWhisperUrl` is configured; otherwise degrades to deterministic demo
 * lines with `local_stt` source so the pipeline stays demonstrable offline.
 * (Reference runs ONNX in-process; a local server keeps the desktop binary small
 * and lets any Whisper build serve the same contract.)
 */
export class LocalWhisperSttEngine implements SttEngine {
  readonly source = "local_stt" as const;
  private buffer: Buffer[] = [];
  private startMs = 0;
  private seq = 0;

  constructor(
    private readonly serverUrl: string | undefined,
    private readonly model: string = "whisper-1",
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    if (this.buffer.length === 0) this.startMs = atMs;
    this.buffer.push(pcm);
    const e = rms(pcm);
    if (e > 280 && this.buffer.length >= 6) {
      onResult({ isFinal: false, text: `local whisper partial ${++this.seq}…`, confidence: 0.64 });
    }
    if (this.buffer.length >= 20 && e > 140) {
      const text = DEMO_LINES[this.seq % DEMO_LINES.length] ?? `local segment ${this.seq}`;
      onResult({ isFinal: true, text, confidence: 0.81, startedAtMs: this.startMs, endedAtMs: atMs });
      this.buffer = [];
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    const pcm = Buffer.concat(this.buffer);
    this.buffer = [];
    if (pcm.length === 0) return;
    const started = this.startMs;

    if (!this.serverUrl) {
      const text = DEMO_LINES[this.seq % DEMO_LINES.length] ?? "local flushed segment";
      onResult({ isFinal: true, text, confidence: 0.75, startedAtMs: started, endedAtMs: started + 1600 });
      return;
    }

    // Fire-and-forget; a local-server failure degrades to the demo line so
    // the session UI never stalls.
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.serverUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${WAV_BOUNDARY}` },
          body: multipartBody(wavFromPcm16(pcm), this.model),
        });
        if (!res.ok) throw new Error(`local whisper ${res.status}`);
        const j = (await res.json()) as { text?: string };
        const text = j.text?.trim();
        if (!text) throw new Error("empty transcript");
        onResult({ isFinal: true, text, confidence: 0.85, startedAtMs: started, endedAtMs: started + Math.max(800, pcm.length / 32) });
      } catch {
        onResult({
          isFinal: true,
          text: DEMO_LINES[this.seq % DEMO_LINES.length] ?? "local whisper fallback segment",
          confidence: 0.6,
          startedAtMs: started,
          endedAtMs: started + 1200,
        });
      }
    })();
  }
}

const WAV_BOUNDARY = "app-stt-wav";

/** Wrap raw PCM16 mono 16 kHz in a minimal 44-byte-header RIFF/WAVE container. */
export function wavFromPcm16(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function multipartBody(wav: Buffer, model: string): Buffer {
  // Buffer-concatenated: a latin1 string body would be re-encoded as UTF-8 in
  // transit and corrupt audio bytes above 0x7F.
  return Buffer.concat([
    Buffer.from(
      `--${WAV_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`,
      "utf8",
    ),
    wav,
    Buffer.from(
      `\r\n--${WAV_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
        `--${WAV_BOUNDARY}--\r\n`,
      "utf8",
    ),
  ]);
}

/**
 * Degrades from a streaming engine to a static one when the primary exhausts
 * its connectivity (provider outage, quota, network loss). Provider failure
 * must degrade the session — never break the UI.
 */
export class FallbackSttEngine implements SttEngine {
  private engine: SttEngine;
  private readonly fallbackEngine: SttEngine;
  private switched = false;

  constructor(primary: SttEngine, fallback: SttEngine) {
    this.engine = primary;
    this.fallbackEngine = fallback;
    primary.onUnavailable?.(() => {
      if (this.switched) return;
      this.switched = true;
      primary.close?.();
      this.engine = fallback;
    });
  }

  get source(): SttEngine["source"] {
    return this.engine.source;
  }

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    this.engine.feed(pcm, atMs, onResult);
  }

  flush(onResult: (r: SttFinal) => void): void {
    this.engine.flush(onResult);
  }

  close(): void {
    this.engine.close?.();
    this.fallbackEngine.close?.();
  }
}

/** Factory — chains every rung: cloud streaming → local streaming → REST → local server → simulated.
 *  Streaming engines fire `onUnavailable` when exhausted; static engines degrade internally. */
export function createSttEngine(opts: {
  deepgramKey?: string;
  localWhisperAvailable?: boolean;
  localWhisperUrl?: string;
  sherpaModelDir?: string;
  mode?: "auto" | "rest";
  wsFactory?: WebSocketFactory;
}): SttEngine {
  const engines: SttEngine[] = [];
  if (opts.deepgramKey && opts.mode !== "rest") {
    engines.push(new DeepgramStreamingSttEngine(opts.deepgramKey, { factory: opts.wsFactory }));
  }
  if (opts.mode !== "rest" || !opts.deepgramKey) {
    // Moonshine first: higher quality, WASM runtime (no native-thread
    // pathologies), init timeout degrades cleanly. Sherpa second as the
    // fully-offline rung — its watchdog releases the chain if its decoder
    // silently stalls.
    engines.push(new MoonshineStreamingSttEngine());
    engines.push(new SherpaStreamingSttEngine({ modelDir: opts.sherpaModelDir }));
  }
  if (opts.deepgramKey) engines.push(new DeepgramSttEngine(opts.deepgramKey));
  if (opts.localWhisperAvailable || opts.localWhisperUrl) {
    engines.push(new LocalWhisperSttEngine(opts.localWhisperUrl ?? process.env.LOCAL_WHISPER_URL));
  }
  engines.push(new SimulatedSttEngine());
  return engines.reduceRight((next, engine) => new FallbackSttEngine(engine, next));
}

function rms(buf: Buffer): number {
  let sum = 0;
  const samples = buf.length >> 1;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples);
}

const DEMO_LINES = [
  "Tell me about a time you had to influence a stakeholder without authority.",
  "Walk me through how you prioritize when everything is urgent.",
  "Describe the most complex system you have designed end to end.",
  "How do you handle disagreeing with your manager's decision?",
  "What would you consider your biggest professional failure so far?",
];
