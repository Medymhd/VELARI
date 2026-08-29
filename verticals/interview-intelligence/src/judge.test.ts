import { test } from "node:test";
import assert from "node:assert/strict";
import { createJudgeState, judgeSuggestion, offlineChunkSummary, type CoachFramework } from "./judge.js";

const good: CoachFramework = {
  detected_question: "Tell me about a conflict you resolved.",
  suggested_outline: ["Situation", "Task", "Action", "Result"],
  talking_points: ["State the stakes", "Own the decision", "Quantify the result"],
  confidence: 0.82,
  requires_user_review: false,
};

test("accepts a well-formed fresh suggestion", () => {
  const state = createJudgeState();
  const v = judgeSuggestion(state, good, 1_000);
  assert.deepEqual(v, { accept: true, reason: "ok" });
});

test("rejects low confidence, missing question, empty outline", () => {
  const state = createJudgeState();
  assert.equal(judgeSuggestion(state, { ...good, confidence: 0.2 }, 0).reason, "low_confidence");
  assert.equal(judgeSuggestion(state, { ...good, detected_question: "" }, 0).reason, "no_question");
  assert.equal(judgeSuggestion(state, { ...good, suggested_outline: [] }, 0).reason, "empty_outline");
});

test("suppresses duplicate question inside the window, allows after it", () => {
  const state = createJudgeState();
  assert.ok(judgeSuggestion(state, good, 0).accept);
  assert.equal(judgeSuggestion(state, good, 30_000).reason, "duplicate_question");
  assert.ok(judgeSuggestion(state, good, 61_000).accept, "same question after the window is a new beat");
});

test("offline summary extracts the last question line", () => {
  const out = offlineChunkSummary("Candidate answered.\nWhy did you choose that tradeoff?\nFollow-up.");
  assert.equal(out.open_question, "Why did you choose that tradeoff?");
  assert.ok(out.summary.length > 0);
});
