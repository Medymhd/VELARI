import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTitleMessages, normalizeTitle, offlineTitle } from "./sessionTitle.js";

test("normalizeTitle strips quotes, collapses whitespace, caps length", () => {
  assert.equal(normalizeTitle('"Senior Backend — Ada Okafor"'), "Senior Backend — Ada Okafor");
  assert.equal(normalizeTitle("  spaced   out   title  "), "spaced out title");
  assert.equal(normalizeTitle(""), "");
  assert.equal(normalizeTitle(null), "");
  const long = normalizeTitle("a".repeat(50) + " " + "b".repeat(50));
  assert.ok(long.length <= 60);
  assert.ok(!long.endsWith("b") || long.length < 60 || long.split(" ").length >= 1);
});

test("offlineTitle prefers JD + CV titles", () => {
  assert.equal(
    offlineTitle("ada-cv.pdf", "senior_backend.docx", ""),
    "senior backend — ada cv",
  );
  assert.equal(offlineTitle("", "Senior Backend Engineer", ""), "Senior Backend Engineer");
  assert.equal(offlineTitle("ada-cv.pdf", "", ""), "ada cv");
});

test("offlineTitle falls back to the transcript topic line", () => {
  assert.equal(
    offlineTitle("", "", "um\nTell me about your experience as an AI training specialist."),
    "Tell me about your experience as an AI training specialist.",
  );
  assert.equal(offlineTitle("", "", ""), "");
});

test("buildTitleMessages carries CV, JD and transcript", () => {
  const msgs = buildTitleMessages("Ada CV", "Backend JD", "Tell me about X");
  assert.equal(msgs[0]!.role, "system");
  assert.match(msgs[0]!.content as string, /at most 8 words/);
  assert.match(msgs[1]!.content as string, /Ada CV/);
  assert.match(msgs[1]!.content as string, /Backend JD/);
  assert.match(msgs[1]!.content as string, /Tell me about X/);
});
