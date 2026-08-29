import type { ModelRequest } from "@app/contracts";
import type { InvokeOutcome, ModelCandidate, ProviderError, RequestContext } from "./provider.js";

export interface ScoredCandidate {
  candidate: ModelCandidate;
  score: number;
}

/**
 * Candidate scoring (architecture doc Â§5):
 *
 *   score =
 *     0.35 Ã— health_score
 *   + 0.25 Ã— latency_fit
 *   + 0.20 Ã— capability_quality
 *   + 0.10 Ã— privacy_fit
 *   + 0.10 Ã— budget_fit
 *   - circuit_breaker_penalty
 */
export function scoreCandidates(
  candidates: ModelCandidate[],
  request: ModelRequest,
  breakerPenalty: (c: ModelCandidate) => number,
): ScoredCandidate[] {
  return candidates
    .map((candidate) => {
      const latencyFit = fit(candidate.avgLatencyMs, request.maxLatencyMs ?? 3000);
      const budgetFit = fit(candidate.costPer1kMicros, request.maxCostMicros ?? 50_000);
      const privacyFit = privacyScore(candidate.privacyMode, request.privacyMode);
      const score =
        0.35 * clamp01(candidate.healthScore) +
        0.25 * latencyFit +
        0.2 * clamp01(candidate.qualityScore) +
        0.1 * privacyFit +
        0.1 * budgetFit -
        breakerPenalty(candidate);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);
}

function fit(value: number, target: number): number {
  if (value <= target) return 1;
  return clamp01(target / value);
}

function privacyScore(mode: ModelCandidate["privacyMode"], requested: ModelRequest["privacyMode"]): number {
  switch (requested) {
    case "local_only":
      return mode === "local" ? 1 : 0; // hard filter upstream too â€” defense in depth
    case "byok_only":
      return mode === "local" ? 1 : mode === "byok" ? 0.9 : 0;
    case "managed_allowed":
      return mode === "local" ? 0.8 : mode === "byok" ? 0.9 : 1;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Hard policy filter applied before scoring. */
export function isEligible(c: ModelCandidate, request: ModelRequest): boolean {
  if (request.privacyMode === "local_only" && c.privacyMode !== "local") return false;
  if (request.privacyMode === "byok_only" && c.privacyMode === "managed") return false;
  return c.healthScore > 0.05;
}

export class ServiceUnavailableError extends Error {
  constructor(
    public readonly taskClass: string,
    public readonly retryAfterSeconds: number,
    public readonly degradedAlternatives: string[],
  ) {
    super(`No eligible provider for task ${taskClass}`);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Route with deadline, single transient retry per candidate, then failover
 * to the next compatible candidate. Mirrors the reference algorithm Â§5.
 */
export async function route(
  request: ModelRequest,
  ctx: RequestContext,
  candidates: ModelCandidate[],
  breakerPenalty: (c: ModelCandidate) => number,
  isAllowed: (c: ModelCandidate) => { allowed: boolean },
  invoke: (c: ModelCandidate, attempt: number) => Promise<InvokeOutcome>,
  hooks?: {
    onSuccess?: (c: ModelCandidate, o: InvokeOutcome) => void;
    onFailure?: (c: ModelCandidate, err: ProviderError) => void;
  },
): Promise<InvokeOutcome> {
  const ranked = scoreCandidates(candidates.filter((c) => isEligible(c, request)), request, breakerPenalty);

  for (const { candidate } of ranked) {
    if (!isAllowed(candidate).allowed) continue;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const outcome = await invoke(candidate, attempt);
      if (outcome.ok && outcome.text !== undefined) {
        hooks?.onSuccess?.(candidate, outcome);
        return outcome;
      }
      const err = outcome.error;
      if (!err) break;
      hooks?.onFailure?.(candidate, err);

      // one retry only, and only for transient errors
      if (!err.isFailoverEligible || attempt >= 2 || err.kind === "invalid_output") break;
    }
  }

  throw new ServiceUnavailableError(request.taskClass, 15, degradedModes(request));
}

function degradedModes(request: ModelRequest): string[] {
  switch (request.taskClass) {
    case "realtime_stt":
      return ["local_whisper_tiny", "manual_transcript"];
    case "live_coach":
      return ["cached_suggestions", "offline_framework_only"];
    default:
      return ["retry_later"];
  }
}

