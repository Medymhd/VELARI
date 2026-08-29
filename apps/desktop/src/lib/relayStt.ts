/**
 * Direct relay path (§5.1.5): when the realtime WS is degraded, native
 * capture audio streams straight to the platform STT relay (HMAC session
 * token) and finals are forwarded back to the session as
 * `transcript.client_final` once the socket recovers.
 */

import { api } from "./api";

export interface RelayResolved {
  relayWsUrl: string;
  sessionToken: string;
}

export async function resolveRelaySession(workspaceId: string): Promise<RelayResolved> {
  const res = await api.sttSession(workspaceId);
  return { relayWsUrl: res.relay_ws_url, sessionToken: res.session_token };
}

export interface RelayDirectOptions {
  url: string;
  token: string;
  onPartial: (text: string, confidence: number) => void;
  onFinal: (text: string, confidence: number) => void;
  onClose?: () => void;
}

const MAX_BUFFERED_CHUNKS = 250;
const KEEPALIVE_MS = 8_000;

interface DeepgramResultFrame {
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
  is_final?: boolean;
}

export class RelayDirectStream {
  private ws: WebSocket | null = null;
  private buffer: Uint8Array[] = [];
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  constructor(private readonly opts: RelayDirectOptions) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`${this.opts.url}?token=${encodeURIComponent(this.opts.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      for (const chunk of this.buffer.splice(0)) ws.send(chunk);
      this.keepAlive = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {
          // close handler takes over
        }
      }, KEEPALIVE_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as DeepgramResultFrame;
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript?.trim();
        if (!text) return;
        if (msg.is_final) this.opts.onFinal(text, alt?.confidence ?? 0.8);
        else this.opts.onPartial(text, alt?.confidence ?? 0.8);
      } catch {
        // non-result metadata frames
      }
    };
    ws.onclose = () => {
      this.stopKeepAlive();
      this.ws = null;
      if (!this.closedByUs) this.opts.onClose?.();
    };
    ws.onerror = () => {
      // close follows; onClose drives any reconnect decision
    };
  }

  /** Raw PCM16 16k bytes; buffered (bounded) while the socket connects. */
  send(pcm: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      return;
    }
    this.buffer.push(pcm);
    if (this.buffer.length > MAX_BUFFERED_CHUNKS) this.buffer.shift();
  }

  finalize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Finalize" }));
      } catch {
        // ignore; final arrives on the next rung or via fallback
      }
    }
  }

  close(): void {
    this.closedByUs = true;
    this.finalize();
    this.stopKeepAlive();
    try {
      this.ws?.close(1000);
    } catch {
      // ignore shutdown races
    }
    this.ws = null;
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}
