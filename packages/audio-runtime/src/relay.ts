/**
 * STT relay client — port of rival `relaySession.ts` semantics.
 *
 * The resolver calls `POST {controlPlaneBaseUrl}/v1/stt/session` (Bearer JWT)
 * and returns a plain session config (or null on ANY failure — it never
 * throws). `RelayStreamingSttEngine` walks the resolver's fallback chain
 * [relay → alternate → emergency] with the direct-provider endpoint as the
 * final rung when a key is available.
 *
 * Security: the session token is NEVER logged; only its presence and the
 * selected region/expiry are.
 */
import type { SttEngine } from "./stt.js";
import { SingleSocketStt, deepgramListenUrl, type WebSocketFactory, type SingleSocketOptions } from "./sttStreaming.js";

export interface RelaySttConfig {
  sampleRate: number;
  audioChannels: number;
  language: string;
  languageAlternates: string[];
  channel: string;
}

export interface RelaySessionLimits {
  maxSampleRate: number;
  maxChannels: number;
  allowDualStream: boolean;
  maxSessionSeconds: number;
  maxBytesPerSession: number;
}

export interface RelaySessionConfig {
  sessionId: string;
  sessionToken: string;
  relayWsUrl: string;
  fallbackRelayWsUrl: string | null;
  emergencyFallbackWsUrl: string;
  selectedRegion: string;
  sttConfig: RelaySttConfig;
  limits: RelaySessionLimits;
  /** Epoch ms at which the session token expires. */
  expiresAt: number;
}

export interface ResolveRelaySessionOpts {
  /** Bearer JWT for the platform API. */
  token: string;
  controlPlaneBaseUrl: string;
  channel: string;
  language?: string;
  languageAlternates?: string[];
  sampleRate?: number;
  audioChannels?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const CACHE_SKEW_MS = 15_000;

/**
 * Calls POST /v1/stt/session and parses the response. Returns null on ANY
 * failure (non-2xx, timeout, network, malformed body, missing token) so the
 * caller degrades to the next rung. NEVER throws; NEVER logs the token.
 */
export async function resolveRelaySession(opts: ResolveRelaySessionOpts): Promise<RelaySessionConfig | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function" || !opts.controlPlaneBaseUrl || !opts.token) return null;

  const url = joinUrl(opts.controlPlaneBaseUrl, "/v1/stt/session");
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        channel: opts.channel,
        language: opts.language ?? "en-US",
        language_alternates: opts.languageAlternates ?? [],
        sample_rate: opts.sampleRate ?? 16_000,
        audio_channels: opts.audioChannels ?? 1,
        intent: "interview",
      }),
      signal: controller.signal,
    });
  } catch {
    return null; // network error / timeout / abort → use the fallback
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return null; // 402 quota etc. — the fallback surfaces the real error

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  return parseSessionResponse(parsed);
}

/** Defensive parse of the resolver contract. Null when token or relay URL are missing. */
function parseSessionResponse(raw: unknown): RelaySessionConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const sessionToken = asStr(o.session_token);
  const relayWsUrl = asStr(o.relay_ws_url);
  if (!sessionToken || !relayWsUrl) return null;

  const stt = (o.stt_config && typeof o.stt_config === "object" ? o.stt_config : {}) as Record<string, unknown>;
  const lim = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;

  return {
    sessionId: asStr(o.session_id) ?? "",
    sessionToken,
    relayWsUrl,
    fallbackRelayWsUrl: asStr(o.fallback_relay_ws_url),
    // Emergency rung defaults to the same relay URL; dedup happens in buildFallbackChain.
    emergencyFallbackWsUrl: asStr(o.emergency_fallback_ws_url) ?? asStr(o.railway_fallback_ws_url) ?? relayWsUrl,
    selectedRegion: asStr(o.selected_region) ?? "primary",
    sttConfig: {
      sampleRate: asNum(stt.sample_rate, 16_000),
      audioChannels: asNum(stt.audio_channels, 1),
      language: asStr(stt.language) ?? "en-US",
      languageAlternates: asStrArr(stt.language_alternates),
      channel: asStr(stt.channel) ?? "default",
    },
    limits: {
      maxSampleRate: asNum(lim.max_sample_rate, 16_000),
      maxChannels: asNum(lim.max_channels, 1),
      allowDualStream: lim.allow_dual_stream === true,
      maxSessionSeconds: asNum(lim.max_session_seconds, 14_400),
      maxBytesPerSession: asNum(lim.max_bytes_per_session, 0),
    },
    expiresAt: parseExpiry(o.expires_at),
  };
}

/**
 * Ordered rungs: [relay, alternate, emergency]. Nulls dropped, duplicates
 * removed. Null config (resolver failed) → empty chain; the engine then goes
 * straight to the direct-provider rung when a key exists.
 */
export function buildFallbackChain(config: RelaySessionConfig | null): string[] {
  if (!config) return [];
  const ordered = [config.relayWsUrl, config.fallbackRelayWsUrl, config.emergencyFallbackWsUrl];
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const url of ordered) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    chain.push(url);
  }
  return chain;
}

// ── Per-channel session cache (skew-aware) ────────────────────────────────

const sessionCache = new Map<string, { config: RelaySessionConfig; validUntil: number }>();

export function getCachedSession(channel: string): RelaySessionConfig | null {
  const entry = sessionCache.get(channel);
  if (!entry) return null;
  if (Date.now() >= entry.validUntil) {
    sessionCache.delete(channel);
    return null;
  }
  return entry.config;
}

export function setCachedSession(channel: string, config: RelaySessionConfig): void {
  sessionCache.set(channel, { config, validUntil: config.expiresAt - CACHE_SKEW_MS });
}

export function clearCachedSession(channel: string): void {
  sessionCache.delete(channel);
}

// ── Chain-walking streaming engine ────────────────────────────────────────

export interface RelayStreamingSttOptions extends Omit<SingleSocketOptions, "urls" | "headersFor"> {
  config: RelaySessionConfig | null;
  /** Direct-provider key for the final rung (optional). */
  deepgramKey?: string;
}

export class RelayStreamingSttEngine extends SingleSocketStt implements SttEngine {
  constructor(opts: RelayStreamingSttOptions) {
    const rungs = buildFallbackChain(opts.config).map((url) => withToken(url, opts.config?.sessionToken));
    if (opts.deepgramKey) rungs.push(deepgramListenUrl());
    super({
      ...opts,
      urls: rungs,
      headersFor: (url) =>
        url === deepgramListenUrl() && opts.deepgramKey
          ? { Authorization: `Token ${opts.deepgramKey}` }
          : undefined,
    });
  }
}

function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

// ── Coercion helpers ──────────────────────────────────────────────────────

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseExpiry(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now(); // unknown lifetime → immediately stale → forces re-resolve
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export type { WebSocketFactory };
