/**
 * Streaming STT over a live WebSocket (port of rival `DeepgramStreamingSTT.ts`
 * semantics, adapted to the SttEngine contract and an injectable socket).
 *
 * `SingleSocketStt` owns the connect/reconnect state machine and walks an
 * ordered list of endpoint rungs (relay → alternate → direct provider). When
 * every rung is exhausted it fires `onUnavailable` exactly once so a caller
 * (FallbackSttEngine) can degrade to the next engine.
 */
import { createRequire } from "node:module";
import type { SttEngine, SttPartial, SttFinal } from "./stt.js";

export interface WebSocketLike {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "message" | "error" | "close", cb: (...args: never[]) => void): void;
}

export type WebSocketFactory = (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

export interface SingleSocketOptions {
  /** Ordered fallback rungs; each rung gets its own reconnect budget. */
  urls: string[];
  /** Per-rung headers (e.g. direct-provider auth). Relay rungs use ?token=. */
  headersFor?: (url: string) => Record<string, string> | undefined;
  factory?: WebSocketFactory;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxAttemptsPerRung?: number;
  connectTimeoutMs?: number;
  keepAliveMs?: number;
  maxBufferedChunks?: number;
}

interface DeepgramResultMessage {
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
  is_final?: boolean;
}

const DEFAULTS = {
  reconnectBaseMs: 400,
  reconnectMaxMs: 8_000,
  maxAttemptsPerRung: 5,
  connectTimeoutMs: 4_000,
  keepAliveMs: 8_000,
  maxBufferedChunks: 250,
} as const;

export class SingleSocketStt implements SttEngine {
  readonly source = "cloud_stt" as const;

  private readonly urls: string[];
  private readonly headersFor: (url: string) => Record<string, string> | undefined;
  private readonly factory: WebSocketFactory;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxAttemptsPerRung: number;
  private readonly connectTimeoutMs: number;
  private readonly keepAliveMs: number;
  private readonly maxBufferedChunks: number;

  private ws: WebSocketLike | null = null;
  private active = false;
  private isOpen = false;
  private isConnecting = false;
  private rungIdx = 0;
  private attemptsInRung = 0;
  private unavailableFired = false;
  private buffer: Buffer[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private onResult: ((r: SttPartial | SttFinal) => void) | null = null;
  private unavailableCb: (() => void) | null = null;
  private utteranceStartedAtMs = 0;
  private lastFeedAtMs = 0;

  constructor(opts: SingleSocketOptions) {
    this.urls = opts.urls;
    this.headersFor = opts.headersFor ?? (() => undefined);
    this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs;
    this.maxAttemptsPerRung = opts.maxAttemptsPerRung ?? DEFAULTS.maxAttemptsPerRung;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
    this.keepAliveMs = opts.keepAliveMs ?? DEFAULTS.keepAliveMs;
    this.maxBufferedChunks = opts.maxBufferedChunks ?? DEFAULTS.maxBufferedChunks;
    this.factory = opts.factory ?? defaultWebSocketFactory();
  }

  onUnavailable(cb: () => void): void {
    this.unavailableCb = cb;
  }

  feed(pcm: Buffer, atMs: number, onResult: (r: SttPartial | SttFinal) => void): void {
    this.onResult = onResult;
    if (!this.active) {
      this.active = true;
      this.connectRung(0);
    }
    if (atMs < this.lastFeedAtMs || this.utteranceStartedAtMs === 0) this.utteranceStartedAtMs = atMs;
    this.lastFeedAtMs = atMs;

    if (!this.isOpen || !this.ws) {
      // Discard the oldest chunks past the cap; fresh speech beats stale audio.
      this.buffer.push(pcm);
      if (this.buffer.length > this.maxBufferedChunks) this.buffer.shift();
      return;
    }
    try {
      this.ws.send(pcm);
    } catch {
      // Close handler drives reconnect.
    }
  }

  flush(onResult: (r: SttFinal) => void): void {
    this.onResult = (r) => {
      if (r.isFinal) onResult(r);
    };
    if (this.isOpen && this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: "Finalize" }));
      } catch {
        // ignore; final will surface on the next connection or via fallback
      }
    }
  }

  close(): void {
    this.active = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.isOpen = false;
    this.isConnecting = false;
    this.buffer = [];
    try {
      ws?.close(1000);
    } catch {
      // ignore shutdown races
    }
  }

  private connectRung(rung: number): void {
    if (this.isConnecting || !this.active) return;
    if (rung >= this.urls.length || rung < 0) {
      this.exhausted();
      return;
    }
    this.rungIdx = rung;
    this.attemptsInRung = 0;
    this.dial();
  }

  private dial(): void {
    if (this.isConnecting || !this.active) return;
    const url = this.urls[this.rungIdx];
    if (!url) {
      this.exhausted();
      return;
    }
    this.isConnecting = true;
    let ws: WebSocketLike;
    try {
      ws = this.factory(url, { headers: this.headersFor(url) });
    } catch {
      this.isConnecting = false;
      this.nextRungOrReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (ws !== this.ws) return; // stale connection guard
      this.isConnecting = false;
      this.isOpen = true;
      this.attemptsInRung = 0;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      const buffered = this.buffer.splice(0);
      for (const chunk of buffered) {
        try {
          ws.send(chunk);
        } catch {
          // close handler takes over
        }
      }
      this.keepAliveTimer = setInterval(() => {
        if (this.isOpen && this.ws) {
          try {
            this.ws.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {
            // ignore
          }
        }
      }, this.keepAliveMs);
      // A stable 5s window proves the rung is healthy → reset its backoff.
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = null;
        if (this.isOpen) this.attemptsInRung = 0;
      }, 5_000);
    });

    ws.on("message", (data: never) => {
      if (ws !== this.ws) return;
      this.handleMessage(data as unknown as string | Buffer);
    });

    ws.on("error", () => {
      // close follows; nothing to do beyond logging context
    });

    // A rung that neither opens nor closes must not hang the chain forever.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (!this.isOpen && this.ws === ws) {
        try {
          ws.close(4000); // close handler advances the chain
        } catch {
          this.ws = null;
          this.nextRungOrReconnect();
        }
      }
    }, this.connectTimeoutMs);

    ws.on("close", (code: never) => {
      if (ws !== this.ws) return;
      this.isOpen = false;
      this.isConnecting = false;
      this.clearTimers();
      this.ws = null;
      if (!this.active) return;
      if (code === 1000) return; // clean shutdown
      // Discard stale audio — replaying seconds-old PCM on reconnect causes
      // provider-side EPIPE storms (rival #lesson).
      this.buffer = [];
      this.nextRungOrReconnect();
    });
  }

  private nextRungOrReconnect(): void {
    this.attemptsInRung += 1;
    if (this.attemptsInRung >= this.maxAttemptsPerRung) {
      this.connectRung(this.rungIdx + 1);
      return;
    }
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attemptsInRung, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.dial();
    }, delay);
  }

  private exhausted(): void {
    this.buffer = [];
    this.isConnecting = false;
    this.isOpen = false;
    if (this.unavailableFired) return;
    this.unavailableFired = true;
    this.unavailableCb?.();
  }

  private handleMessage(data: string | Buffer): void {
    let msg: DeepgramResultMessage;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString()) as DeepgramResultMessage;
    } catch {
      return;
    }
    const alt = msg.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text || !this.onResult) return;
    const confidence = alt?.confidence ?? 0.8;
    if (msg.is_final) {
      const startedAtMs = this.utteranceStartedAtMs || this.lastFeedAtMs;
      this.utteranceStartedAtMs = 0;
      this.onResult({
        isFinal: true,
        text,
        confidence,
        startedAtMs,
        endedAtMs: Math.max(this.lastFeedAtMs, startedAtMs + 200),
      });
    } else {
      this.onResult({ isFinal: false, text, confidence });
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.keepAliveTimer = null;
    this.stabilityTimer = null;
  }
}

function defaultWebSocketFactory(): WebSocketFactory {
  // Lazy `ws` resolution keeps the dependency optional for consumers that
  // inject their own factory (tests, browser-adjacent bundles).
  const req = createRequire(import.meta.url);
  const WS = req("ws") as { WebSocket: new (url: string, opts?: { headers?: Record<string, string> }) => WebSocketLike };
  return (url, options) => new WS.WebSocket(url, options);
}

/** Canonical Deepgram live endpoint (16 kHz linear16 mono, interim results).
 *  vad_events + utterance_end_ms = rival parity: speech_final/utterance_end
 *  events surface mid-speech pauses so consumers can finalize utterances. */
export function deepgramListenUrl(): string {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    vad_events: "true",
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

/** Direct-provider streaming engine: single rung, Token auth header. */
export class DeepgramStreamingSttEngine extends SingleSocketStt {
  constructor(apiKey: string, opts: Omit<SingleSocketOptions, "urls" | "headersFor"> = {}) {
    super({
      ...opts,
      urls: [deepgramListenUrl()],
      headersFor: () => ({ Authorization: `Token ${apiKey}` }),
    });
  }
}
