import assert from "node:assert/strict";
import { test } from "node:test";
import { stripLeakage, sanitizeCoachFramework } from "./postProcess.js";

test("stripLeakage ends unpunctuated lines with a period", () => {
  assert.equal(stripLeakage("I led the migration"), "I led the migration.");
});

test("stripLeakage preserves existing sentence punctuation", () => {
  assert.equal(stripLeakage("I led the migration. It saved hours."), "I led the migration. It saved hours.");
  assert.equal(stripLeakage("Did it work?"), "Did it work?");
});

test("stripLeakage splits 'and then' run-ons into sentences", () => {
  const out = stripLeakage("I built the pipeline, and then the team scaled it");
  assert.equal(out, "I built the pipeline. The team scaled it.");
});

test("stripLeakage removes AI tells", () => {
  const out = stripLeakage("I would delve into the data and utilize dashboards");
  assert.ok(!/delve|utilize/i.test(out));
});

test("stripLeakage strips JSON envelopes and schema stubs", () => {
  assert.equal(stripLeakage('{"detected_question": "x"}'), "");
});

test("sanitizeCoachFramework keeps the framework speakable and capped", () => {
  const fw = sanitizeCoachFramework({
    detected_question: "How would you evaluate an AI response using a rubric?",
    suggested_outline: ["Define the rubric", "Give a metric", "Close with a result", "Extra one", "Extra two"],
    talking_points: ["Accuracy, relevance, clarity. Then a flagging story with a 15% number.", "", "ok"],
    confidence: 0.9,
    requires_user_review: false,
  });
  assert.ok(fw);
  assert.equal(fw.suggested_outline.length, 4);
  assert.ok(fw.talking_points.length <= 3);
});

test("sanitizeCoachFramework preserves unknown extra fields is not required — returns core shape", () => {
  const fw = sanitizeCoachFramework({
    detected_question: "q",
    suggested_outline: ["a"],
    talking_points: ["b."],
    confidence: 0.5,
    requires_user_review: true,
  });
  assert.ok(fw);
  assert.equal(fw.detected_question, "q."); // unpunctuated input gets a terminal period
});
