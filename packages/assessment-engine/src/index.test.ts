import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAssessment, calibrationDrift } from "./index.js";

test("scoreAssessment weights correctly", () => {
  const rubric = {
    id: "r1",
    version: 1,
    title: "Accuracy",
    criteria: [
      { id: "c1", name: "Accuracy", description: "factual", weight: 3, scoreBands: [{ min: 0, max: 5, label: "poor" }], requiredEvidence: [] },
      { id: "c2", name: "Completeness", description: "complete", weight: 2, scoreBands: [{ min: 0, max: 5, label: "poor" }], requiredEvidence: [] },
    ],
    gradingPolicy: { passThreshold: 0.6 },
    status: "active" as const,
  };
  const a = scoreAssessment(rubric, [
    { criterionId: "c1", score: 5, evidence: ["cite"], confidence: 0.9 },
    { criterionId: "c2", score: 5, evidence: [], confidence: 0.8 },
  ]);
  assert.equal(a.totalScore, 25);
  assert.equal(a.normalized, 1);
  assert.equal(a.pass, true);
});

test("calibrationDrift detects drift", () => {
  assert.ok(Math.abs(calibrationDrift([0.8, 0.8], [0.5, 0.5]) - 0.3) < 1e-9);
  assert.equal(calibrationDrift([], []), 0);
});
