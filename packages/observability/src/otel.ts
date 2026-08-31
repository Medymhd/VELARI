import { spanSink } from "./index.js";

/**
 * OTel exporter stub — mirrors reference `spanSink` → OTLP.
 * Wire to `@opentelemetry/sdk-node` by setting `spanSink.fn`.
 * Example:
 *   import { NodeSDK } from "@opentelemetry/sdk-node";
 *   spanSink.fn = (span) => sdk.getTracer("app").startSpan(span.name).end();
 */
export function enableOtel(exporter: (span: { traceId: string; name: string; durationMs: number; ok: boolean }) => void): void {
  spanSink.fn = exporter;
}

export function disableOtel(): void {
  spanSink.fn = null;
}
