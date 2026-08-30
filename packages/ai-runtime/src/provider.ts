import type { ModelRequest } from "@app/contracts";

/**
 * Provider contract (architecture doc Â§5).
 * A provider never sees raw workspace data beyond what the request carries,
 * and receives credentials only at call time via `ctx.secretRef` resolution
 * performed by the caller (API layer), never stored here.
 */
export interface RequestContext {
  workspaceId: string;
  requestId: string;
  traceId: string;
  /** Resolved plaintext secret for byok providers; undefined for local. */
  secret?: string | undefined;
}

export interface ProviderHealthState {
  score: number;
  lastError: string | null;
  updatedAt: number;
}

export interface InvokeOutcome {
  ok: boolean;
  text?: string;
  structured?: Record<string, unknown> | null;
  inputUnits?: number;
  outputUnits?: number;
  latencyMs?: number;
  providerId?: string;
  error?: ProviderError;
}

export class ProviderError extends Error {
  constructor(
    public readonly kind:
      | "timeout"
      | "connection"
      | "rate_limited" // 429 â†’ failover eligible
      | "unavailable" // 503/504 â†’ failover eligible
      | "auth" // not eligible until credentials updated
      | "invalid_input" // not eligible
      | "policy_denied" // not eligible
      | "safety_refusal" // surface transparently, not eligible
      | "invalid_output", // eligible after one repair attempt
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Failover eligibility rules (architecture doc Â§5). */
  get isFailoverEligible(): boolean {
    switch (this.kind) {
      case "timeout":
      case "connection":
      case "rate_limited":
      case "unavailable":
      case "invalid_output":
        return true;
      case "auth":
      case "invalid_input":
      case "policy_denied":
      case "safety_refusal":
        return false;
    }
  }
}

export interface ModelCandidate {
  providerId: string;
  model: string;
  capabilities: string[];
  privacyMode: "local" | "byok" | "managed";
  healthScore: number;
  avgLatencyMs: number;
  costPer1kMicros: number;
  qualityScore: number; // 0..1 capability-quality prior
}

export abstract class AIProvider {
  abstract readonly id: string;
  abstract capabilities(): Promise<string[]>;
  abstract health(): Promise<ProviderHealthState>;
  abstract execute(request: ModelRequest, ctx: RequestContext): Promise<InvokeOutcome>;
}

