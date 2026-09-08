import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSheetMessages, offlineSheet, normalizeSheet, type QuestionSheet } from "./interviewerSheet.js";

test("normalizeSheet clamps LLM output into the QuestionSheet contract", () => {
  const raw = {
    questions: [
      {
        question: "Walk me through the migration you led at Acme.",
        intent: "verify the CV's flagship claim",
        whatGoodLooksLike: "Scope, ownership, a metric",
        probes: ["What did you cut?", "x"], // "x" filtered (too short)
        difficulty: "core",
      },
      { question: "hi", intent: "", whatGoodLooksLike: "", probes: [], difficulty: "warmup" }, // too short — dropped
      { question: "No difficulty field here", intent: "", whatGoodLooksLike: "", probes: "not-array" }, // defaults to core
    ],
  };
  const sheet = normalizeSheet(raw);
  assert.ok(sheet);
  assert.equal(sheet.questions.length, 2);
  assert.equal(sheet.questions[0]!.probes.length, 1);
  assert.equal(sheet.questions[1]!.difficulty, "core");
});

test("normalizeSheet rejects non-array / empty payloads", () => {
  assert.equal(normalizeSheet(null), null);
  assert.equal(normalizeSheet({}), null);
  assert.equal(normalizeSheet({ questions: [] }), null);
});

test("offlineSheet produces a laddered, CV-grounded fallback", () => {
  const sheet: QuestionSheet = offlineSheet(
    "Led the Kubernetes migration at Acme, cut costs 30%. Expert in Rust and Kafka.",
    "Senior platform engineer: Kubernetes, Rust, Kafka, incident response.",
  );
  const diffs = sheet.questions.map((q) => q.difficulty);
  assert.ok(diffs.includes("warmup"));
  assert.ok(diffs.includes("core"));
  assert.ok(diffs.includes("pressure"));
  for (const q of sheet.questions) {
    assert.ok(q.question.length >= 8);
    assert.ok(q.intent.length > 0);
    assert.ok(q.whatGoodLooksLike.length > 0);
    assert.ok(Array.isArray(q.probes));
  }
});

test("buildSheetMessages: CV + JD land in the user turn, contract in the system turn", () => {
  const msgs = buildSheetMessages("CV: built X", "JD: needs Y", 8);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[1]!.role, "user");
  // buildSheetMessages always produces string content; the contract's union
  // type just doesn't narrow it — cast for the assertions.
  const system = msgs[0]!.content as string;
  const user = msgs[1]!.content as string;
  assert.ok(user.includes("CV: built X"));
  assert.ok(user.includes("JD: needs Y"));
  assert.ok(system.includes("warmup"));
});
