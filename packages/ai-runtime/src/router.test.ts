import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidates, isEligible } from "./router.js";
import type { ModelRequest } from "@app/contracts";
import type { ModelCandidate } from "./provider.js";

const req: ModelRequest = {
  taskClass: "live_coach",
  privacyMode: "managed_allowed",
};

function cand(over: Partial<ModelCandidate>): ModelCandidate {
  return {
    providerId: "p",
    model: "m",
    capabilities: ["chat"],
    privacyMode: "managed",
    healthScore: 1,
    avgLatencyMs: 500,
    costPer1kMicros: 100,
    qualityScore: 0.8,
    ...over,
  };
}

test("privacy hard-filters local_only requests", () => {
  assert.equal(isEligible(cand({ privacyMode: "managed" }), { ...req, privacyMode: "local_only" }), false);
  assert.equal(isEligible(cand({ privacyMode: "local" }), { ...req, privacyMode: "local_only" }), true);
});

test("scoring prefers healthy, low-latency, private candidates", () => {
  const ranked = scoreCandidates(
    [
      cand({ providerId: "slow", avgLatencyMs: 9000 }),
      cand({ providerId: "good", healthScore: 0.95, avgLatencyMs: 300 }),
      cand({ providerId: "unhealthy", healthScore: 0.02 }),
    ],
    req,
    () => 0,
  );
  assert.equal(ranked[0]?.candidate.providerId, "good");
});

test("breaker penalty demotes a candidate", () => {
  const c = cand({});
  const clean = scoreCandidates([c], req, () => 0)[0]?.score ?? 0;
  const penalized = scoreCandidates([c], req, () => 1)[0]?.score ?? 0;
  assert.ok(clean > penalized);
});

