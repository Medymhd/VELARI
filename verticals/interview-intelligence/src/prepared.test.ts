import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPreparedQa, type PreparedQa } from "./prepared.js";

const BANK: PreparedQa[] = [
  {
    id: "1",
    title: "Weakness question",
    content: "Q: What is your greatest weakness? A: I used to over-polish deliverables. I now timebox review passes and ship, then iterate on feedback.",
  },
  {
    id: "2",
    title: "Conflict story",
    content: "Q: Tell me about a conflict with a colleague. A: Our lead wanted a rewrite, I wanted an incremental fix. I proposed a two-day spike comparing both, data picked the incremental path, and we shipped a week early.",
  },
  {
    id: "3",
    title: "Notes without Q marker",
    content: "Kubernetes rollout strategy: blue-green with canary at 5% for 30 minutes, then full cutover.",
  },
];

test("matches a rephrased question to the drilled answer", () => {
  const m = matchPreparedQa("Can you describe your greatest weakness?", BANK);
  assert.ok(m);
  assert.equal(m.qa.id, "1");
  assert.ok(m.answer.startsWith("I used to over-polish"));
  assert.ok(m.score >= 0.34);
});

test("matches behavioral rephrase", () => {
  const m = matchPreparedQa("Tell me about a time you disagreed with a teammate.", BANK);
  assert.ok(m);
  assert.equal(m.qa.id, "2");
});

test("returns null below the relevance floor", () => {
  const m = matchPreparedQa("What is the airspeed velocity of an unladen swallow?", BANK);
  assert.equal(m, null);
});

test("returns null on empty bank or empty question", () => {
  assert.equal(matchPreparedQa("anything", []), null);
  assert.equal(matchPreparedQa("", BANK), null);
});

test("matches unmarked docx shape: question sentence followed by answer", () => {
  const docx: PreparedQa[] = [
    {
      id: "d1",
      title: "sample interview",
      content:
        "Tell me about your experience as an AI training specialist. I'm a Computer Science professional focused on evaluating and improving AI generated outputs. I review responses to technical and programming questions and assess them against criteria such as factual correctness, logical consistency, relevance, instruction following and safety.",
    },
  ];
  const m = matchPreparedQa("Can you tell me about your experience as an AI training specialist?", docx);
  assert.ok(m, "expected a match on the unmarked docx entry");
  assert.ok(m.answer.includes("Computer Science professional"), "answer should be the text following the matched question sentence");
});

test("no false positive on unrelated question (unmarked doc)", () => {
  const docx: PreparedQa[] = [
    { id: "d2", title: "s", content: "Tell me about your experience as an AI training specialist. I'm a Computer Science professional." },
  ];
  assert.equal(matchPreparedQa("What is your greatest weakness?", docx), null);
});
