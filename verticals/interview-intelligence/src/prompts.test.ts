import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoachMessages, offlineFramework } from "./prompts.js";

test("coach prompt carries schema and transcript", () => {
  const msgs = buildCoachMessages({ verbatimTranscript: "Tell me about scaling." });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!.content as string, /detected_question/);
  assert.match(msgs[1]!.content as string, /Tell me about scaling\./);
});

test("offline framework extracts last question", () => {
  const f = offlineFramework("Warm up chat. What is your biggest failure? Answer here.");
  assert.equal(f.detected_question, "What is your biggest failure?");
});
