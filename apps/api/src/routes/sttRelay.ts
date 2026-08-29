/**
 * STT relay — control-plane session minting + WebSocket pipe to the STT
 * provider (port of the rival control-plane contract, adapted to our API).
 *
 * POST /v1/stt/session   JWT-protected; mints a short-lived HMAC session
 *                        token and returns the resolver-shape config the
 *                        client walks as a fallback chain.
 * GET  /v1/stt/relay     WebSocket upgrade (exempt from the global JWT hook);
 *                        authenticates via ?token=<HMAC session token>, then
 *                        pipes frames to the provider's live socket. Binary
 *                        audio passes through untouched; textual frames are
 *                        provider control messages (KeepAlive/Finalize).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { deepgramListenUrl } from "@app/ai-runtime";
import { env } from "../env.js";
import { secretBox } from "../secrets.js";
import { logger } from "@app/observability";
import { prisma } from "../db.js";

const log = logger({ svc: "stt-relay" });

const TOKEN_TTL_MS = 90_000;
const MAX_BYTES_PER_SESSION = 25 * 1024 * 1024;

export interface SttSessionClaims {
  sub: string; // `${userId}:${workspaceId}`
  ws: "stt-relay";
  exp: number;
}

export function mintSessionToken(sub: string, opts: { ttlMs?: number; secret?: string; nowMs?: number } = {}): string {
  const claims: SttSessionClaims = { sub, ws: "stt-relay", exp: (opts.nowMs ?? Date.now()) + (opts.ttlMs ?? TOKEN_TTL_MS) };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", opts.secret ?? env.relayHmacSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string, opts: { secret?: string; nowMs?: number } = {}): SttSessionClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || token.split(".").length !== 2) return null;
  const expected = createHmac("sha256", opts.secret ?? env.relayHmacSecret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as SttSessionClaims;
    if (claims.ws !== "stt-relay" || !claims.sub || typeof claims.exp !== "number") return null;
    if ((opts.nowMs ?? Date.now()) >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

function relayEndpointUrl(): string {
  return `${env.publicUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/stt/relay`;
}

/** Workspace BYOK secret first, then the platform env key, else null (402). */
async function resolveDeepgramKey(workspaceId: string): Promise<string | null> {
  const conn = await prisma.providerConnection.findFirst({
    where: { workspaceId, provider: "deepgram", status: "active", secretRef: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (conn?.secretRef) {
    try {
      return secretBox.open(conn.secretRef);
    } catch {
      // fall through to the env key
    }
  }
  return process.env.DEEPGRAM_API_KEY ?? null;
}

interface RelayQuery {
  token?: string;
}

interface RelaySocket {
  send(data: RawData, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: "close", cb: (code: number, reason: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export function sttRelayRoutes(app: FastifyInstance): void {
  app.post("/v1/stt/session", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      channel?: string;
      language?: string;
      sampleRate?: number;
      audioChannels?: number;
    };
    if (!body.workspaceId) return reply.status(400).send({ error: "workspaceId is required" });

    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: body.workspaceId, userId } },
    });
    if (!member) return reply.status(403).send({ error: "not a workspace member" });

    const key = await resolveDeepgramKey(body.workspaceId);
    if (!key) {
      return reply.status(402).send({ error: "payment_required", message: "no active Deepgram provider connection or DEEPGRAM_API_KEY" });
    }

    const sessionToken = mintSessionToken(`${userId}:${body.workspaceId}`);
    const relayUrl = relayEndpointUrl();
    return reply.send({
      session_id: randomUUID(),
      session_token: sessionToken,
      relay_ws_url: relayUrl,
      fallback_relay_ws_url: null,
      railway_fallback_ws_url: relayUrl,
      selected_region: "primary",
      stt_config: {
        sample_rate: body.sampleRate ?? 16_000,
        audio_channels: body.audioChannels ?? 1,
        language: body.language ?? "en-US",
        language_alternates: [],
        channel: body.channel ?? "default",
      },
      limits: {
        max_sample_rate: 16_000,
        max_channels: 1,
        allow_dual_stream: false,
        max_session_seconds: 14_400,
        max_bytes_per_session: MAX_BYTES_PER_SESSION,
      },
      quota_remaining: -1,
      expires_at: Date.now() + TOKEN_TTL_MS,
    });
  });

  (app as any).get("/v1/stt/relay", { websocket: true }, async (socket: RelaySocket, req: { query: RelayQuery }) => {
    const claims = req.query.token ? verifySessionToken(req.query.token) : null;
    if (!claims) {
      socket.close(1008, "unauthorized");
      return;
    }
    const workspaceId = claims.sub.split(":")[1] ?? "";
    const key = await resolveDeepgramKey(workspaceId);
    if (!key) {
      socket.close(1013, "no_provider_configured");
      return;
    }

    let upstream: WebSocket | null = null;
    let bytesRelayed = 0;
    let closed = false;

    const teardown = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      try {
        upstream?.close(1000);
      } catch {
        // ignore
      }
      try {
        socket.close(code, reason);
      } catch {
        // ignore
      }
    };

    // Session tokens are short-lived; enforce expiry server-side too.
    const expiryTimer = setTimeout(() => teardown(1008, "session_expired"), Math.max(0, claims.exp - Date.now()));

    socket.on("message", (data, isBinary) => {
      if (!upstream) return;
      if (!isBinary) {
        // Provider control frame (KeepAlive/Finalize) — pass through.
        upstream.send(data.toString());
        return;
      }
      // RawData is Buffer | ArrayBuffer | Buffer[] — normalize before use.
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      bytesRelayed += buf.length;
      if (bytesRelayed > MAX_BYTES_PER_SESSION) {
        teardown(1009, "byte_limit_exceeded");
        return;
      }
      upstream.send(buf);
    });
    socket.on("close", () => {
      clearTimeout(expiryTimer);
      teardown(1000, "client_closed");
    });
    socket.on("error", (err) => {
      log.warn("relay client error", { error: err.message });
      clearTimeout(expiryTimer);
      teardown(1011, "client_error");
    });

    upstream = new WebSocket(deepgramListenUrl(), { headers: { Authorization: `Token ${key}` } });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      try {
        socket.send(data, { binary: isBinary });
      } catch {
        // client vanished; close handler cleans up
      }
    });
    upstream.on("close", () => {
      clearTimeout(expiryTimer);
      teardown(1000, "upstream_closed");
    });
    upstream.on("error", (err) => {
      log.warn("relay upstream error", { error: err.message });
      clearTimeout(expiryTimer);
      teardown(1011, "upstream_error");
    });
  });
}
