import { test } from "node:test";
import assert from "node:assert/strict";
import { newAssemblerState, ingestSegment, verbatimWindow, assertStartAllowed } from "./index.js";
import type { TranscriptSegmentDto } from "@app/contracts";

function seg(seq: number, text: string, isFinal = true): TranscriptSegmentDto {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, "0")}`,
    sessionId: "11111111-1111-4111-8111-111111111111",
    sequenceNo: seq,
    startedAtMs: seq * 1000,
    endedAtMs: seq * 1000 + 500,
    text,
    confidence: 0.9,
    isFinal,
    source: "cloud_stt",
  };
}

test("assembler dedupes by eventId and orders finals", () => {
  const s = newAssemblerState();
  ingestSegment(s, seg(0, "hello"), "e1");
  ingestSegment(s, seg(0, "hello"), "e1"); // duplicate
  ingestSegment(s, seg(1, "tell me about scale", true), "e2");
  assert.equal(s.finals.length, 2);
  assert.equal(s.finals[1]!.text, "tell me about scale");
});

test("assembler rejects superseded sequences", () => {
  const s = newAssemblerState();
  ingestSegment(s, seg(3, "later final"), "e9");
  assert.throws(() => ingestSegment(s, seg(0, "old"), "e10"));
});

test("verbatim window includes partials after finals", () => {
  const s = newAssemblerState();
  ingestSegment(s, seg(0, "first question?"), "a");
  ingestSegment(s, seg(1, "partial ans", false), "b");
  const w = verbatimWindow(s);
  assert.ok(w.includes("first question?"));
  assert.ok(w.includes("partial ans"));
});

test("start blocked without consent", () => {
  assert.throws(() => assertStartAllowed("pending"));
  assert.doesNotThrow(() => assertStartAllowed("confirmed"));
});

