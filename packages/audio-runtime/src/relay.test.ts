import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRelaySession, buildFallbackChain, RelayStreamingSttEngine } from "./relay.js";
import type { RelaySessionConfig } from "./relay.js";
import type { WebSocketLike } from "./sttStreaming.js";

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const SESSION_BODY = {
  session_id: "sess-1",
  session_token: "tok-secret-value",
  relay_ws_url: "wss://relay.example/v1/stt/relay",
  fallback_relay_ws_url: "wss://alt-relay.example/v1/stt/relay",
  railway_fallback_ws_url: "wss://emergency.example/v1/stt/relay",
  selected_region: "us",
  stt_config: { sample_rate: 16000, audio_channels: 1, language: "en-US", language_alternates: [], channel: "default" },
  limits: { max_sample_rate: 16000, max_channels: 1, allow_dual_stream: false, max_session_seconds: 14400, max_bytes_per_session: 1000 },
  expires_at: Date.now() + 90_000,
};

const baseOpts = {
  token: "jwt-token",
  controlPlaneBaseUrl: "https://api.example",
  channel: "system",
};

async function noSession(): Promise<RelaySessionConfig | null> {
  return null;
}
void noSession;

test("resolver parses a valid response into the session config", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const cfg = await resolveRelaySession({
    ...baseOpts,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return okResponse(SESSION_BODY);
    },
  });
  assert.ok(cfg);
  assert.equal(cfg.sessionToken, "tok-secret-value");
  assert.equal(cfg.relayWsUrl, "wss://relay.example/v1/stt/relay");
  assert.equal(cfg.sttConfig.sampleRate, 16000);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0]!.url).endsWith("/v1/stt/session"));
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer jwt-token");
});

test("resolver null-ladder: any failure returns null, never throws", async () => {
  const cases: Parameters<typeof resolveRelaySession>[0][] = [
    // missing credential
    { ...baseOpts, token: "" },
    // missing base url
    { ...baseOpts, controlPlaneBaseUrl: "" },
    // network error
    { ...baseOpts, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
    // timeout (abort)
    { ...baseOpts, fetchImpl: async (_u, init) => {
        await new Promise<void>((resolve) => {
          init!.signal!.addEventListener("abort", () => resolve());
        });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }, timeoutMs: 1 },
    // non-2xx (402 quota)
    { ...baseOpts, fetchImpl: async () => ({ ok: false, status: 402 }) as unknown as Response },
    // malformed JSON
    { ...baseOpts, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response },
    // missing session_token
    { ...baseOpts, fetchImpl: async () => okResponse({ ...SESSION_BODY, session_token: "" }) },
    // missing relay_ws_url
    { ...baseOpts, fetchImpl: async () => okResponse({ ...SESSION_BODY, relay_ws_url: null }) },
    // non-object body
    { ...baseOpts, fetchImpl: async () => okResponse("nope") },
  ];
  for (const [i, opts] of cases.entries()) {
    const result = await resolveRelaySession(opts).catch(() => "threw");
    assert.equal(result, null, `case ${i} must resolve to null without throwing`);
  }
});

test("fallback chain: nulls dropped, duplicates removed, resolver failure → empty", async () => {
  const cfg: RelaySessionConfig = {
    sessionId: "s",
    sessionToken: "t",
    relayWsUrl: "wss://a",
    fallbackRelayWsUrl: null,
    emergencyFallbackWsUrl: "wss://a",
    selectedRegion: "us",
    sttConfig: { sampleRate: 16000, audioChannels: 1, language: "en-US", languageAlternates: [], channel: "default" },
    limits: { maxSampleRate: 16000, maxChannels: 1, allowDualStream: false, maxSessionSeconds: 1, maxBytesPerSession: 0 },
    expiresAt: Date.now() + 1000,
  };
  assert.deepEqual(buildFallbackChain(cfg), ["wss://a"]);
  assert.deepEqual(buildFallbackChain(await noSession()), []);
});

class FakeSocket implements WebSocketLike {
  sent: (string | Buffer)[] = [];
  private handlers = new Map<string, ((...args: never[]) => void)[]>();
  on(event: "open" | "message" | "error" | "close", cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.emit("close", code ?? 1000);
  }
  open(): void {
    this.emit("open");
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("engine walks relay → alternate → emergency → direct deepgram in order", async () => {
  const dialed: { url: string; headers?: Record<string, string> }[] = [];
  const cfg = await resolveRelaySession({
    ...baseOpts,
    fetchImpl: async () => okResponse(SESSION_BODY),
  });
  const engine = new RelayStreamingSttEngine({
    config: cfg,
    deepgramKey: "dg-key",
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    maxAttemptsPerRung: 1,
    connectTimeoutMs: 1,
    factory: (url, options) => {
      dialed.push({ url, headers: options?.headers });
      const s = new FakeSocket();
      return s;
    },
  });

  engine.feed(Buffer.alloc(16), 0, () => {});
  await sleep(5); // rung 1 (relay) closes → rung 2
  await sleep(5); // rung 2 (alternate) closes → rung 3
  await sleep(5); // rung 3 (emergency) closes → rung 4 (direct)
  engine.close();

  assert.ok(dialed.length >= 3, `expected at least 3 rungs dialed, got ${dialed.length}`);
  assert.ok(dialed[0]!.url.startsWith("wss://relay.example"), `rung 1 is the relay: ${dialed[0]!.url}`);
  assert.ok(dialed[0]!.url.includes("token="), "relay rung carries the session token");
  assert.ok(dialed[1]!.url.startsWith("wss://alt-relay.example"), `rung 2 is the alternate: ${dialed[1]!.url}`);
  assert.ok(dialed[2]!.url.startsWith("wss://emergency.example"), `rung 3 is the emergency rung: ${dialed[2]!.url}`);

  const direct = dialed.find((d) => d.url.includes("api.deepgram.com"));
  assert.ok(direct, "final rung is direct Deepgram when a key exists");
  assert.equal(direct.headers?.Authorization, "Token dg-key");
  assert.ok(!direct.url.includes("token="), "direct rung uses the auth header, not the query token");
});
