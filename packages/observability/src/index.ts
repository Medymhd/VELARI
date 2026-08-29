/**
 * App observability: structured logging with content-free defaults,
 * redaction, and trace-id propagation. OpenTelemetry export is a seam â€”
 * swap `spanSink` for an OTLP exporter without touching call sites.
 */
import { randomUUID } from "node:crypto";
import { redactSecretLike } from "@app/security";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  traceId?: string;
  workspaceId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: number = LEVELS[process.env.LOG_LEVEL === "debug" ? "debug" : "info"];

/** Content (transcripts, prompts) is never logged by default (doc Â§12). */
export let contentLoggingConsent = false;
export function setContentLoggingConsent(v: boolean): void {
  contentLoggingConsent = v;
}

export type SpanSink = (span: { traceId: string; name: string; durationMs: number; ok: boolean }) => void;
export const spanSink: { fn: SpanSink | null } = { fn: null };

function serialize(fields: LogFields): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") safe[k] = redactSecretLike(v);
    else safe[k] = v;
  }
  return safe;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(base: LogFields): Logger;
}

export function logger(base: LogFields = {}): Logger {
  const emit = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LEVELS[level] < minLevel) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...serialize({ ...base, ...fields }),
    });
    process.stdout.write(line + "\n");
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child(extra: LogFields): Logger {
      return logger({ ...base, ...extra });
    },
  };
}

export function newTraceId(): string {
  return randomUUID();
}

/** Time a unit of work and forward to the span sink when present. */
export async function traced<T>(name: string, traceId: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    spanSink.fn?.({ traceId, name, durationMs: Date.now() - started, ok: true });
    return result;
  } catch (e) {
    spanSink.fn?.({ traceId, name, durationMs: Date.now() - started, ok: false });
    throw e;
  }
}

/** Metrics registry matching doc Â§12 observable list. */
const counters = new Map<string, number>();
export function increment(metric: string, by = 1): void {
  counters.set(metric, (counters.get(metric) ?? 0) + by);
}
export function snapshotMetrics(): Record<string, number> {
  return Object.fromEntries(counters);
}
export const METRICS = {
  sttPartialLatencyMs: "stt.partial.latency_ms",
  llmFirstTokenMs: "llm.first_token_ms",
  providerFallbacks: "provider.fallback.count",
  sessionCompletions: "session.completed.count",
  permissionDenials: "permission.denied.count",
} as const;


