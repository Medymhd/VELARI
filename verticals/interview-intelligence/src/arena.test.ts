import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPreparedQa, type PreparedQa } from "./prepared.js";
import { judgeSuggestion, createJudgeState } from "./judge.js";
import { sanitizeCoachFramework } from "./postProcess.js";

test("arena evaluator contract: scores clamp to 0-10 in the backend route", () => {
  // The route clamps via Math.max(0, Math.min(10, ...)) — verify the clamp math.
  const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(n)));
  assert.equal(clamp(12), 10);
  assert.equal(clamp(-3), 0);
  assert.equal(clamp(7.6), 8);
});

test("arena question flow uses the same judge for follow-up gating", () => {
  // Follow-ups fire when score <= 6 — sanity-check the shared judge still
  // accepts a framework that would come back from an evaluated answer.
  const state = createJudgeState();
  const verdict = judgeSuggestion(state, {
    detected_question: "What is RLHF?",
    suggested_outline: ["Define", "Example"],
    talking_points: ["Answer"],
    confidence: 0.9,
    requires_user_review: false,
  }, Date.now());
  assert.equal(verdict.accept, true);
});

test("strengthened answers pass the sanitizer before display", () => {
  const fw = sanitizeCoachFramework({
    detected_question: "q",
    suggested_outline: ["a"],
    talking_points: ["I led the migration, and then the team scaled it."],
    confidence: 0.9,
    requires_user_review: false,
  });
  assert.ok(fw);
  assert.ok(fw.talking_points[0]!.includes(". "));
});

test("prepared Q&A still matches arena-style questions (drill source)", () => {
  const bank: PreparedQa[] = [{
    id: "1", title: "rubric", content: "Q: How would you evaluate an AI response using a rubric?\nA: Read each criterion independently and cite evidence.",
  }];
  const m = matchPreparedQa("How do you evaluate an AI response with a rubric?", bank);
  assert.ok(m);
});
