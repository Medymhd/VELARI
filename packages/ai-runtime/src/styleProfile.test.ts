import { test } from "node:test";
import assert from "node:assert/strict";
import { captureStyleProfile, stylePrompt, withStyle, deserializeProfile, serializeProfile } from "./styleProfile.js";

const SAMPLE = `I've been working on distributed systems for about six years now — mostly event-driven
architectures with Kafka and gRPC. Honestly, the hardest part isn't the tech; it's the
organizational buy-in. You need to get people to trust the migration path. Generally I
start with a strangler pattern around the highest-traffic endpoint, measure everything,
and expand only when the metrics hold. We reduced p99 latency by 40% doing this at scale.`;

test("captureStyleProfile extracts measurable voice features", () => {
  const p = captureStyleProfile([SAMPLE]);
  assert.ok(p.avgSentenceLength > 5 && p.avgSentenceLength < 40, `avgLen ${p.avgSentenceLength}`);
  assert.ok(p.sentenceLengthVariance > 0, "sentences vary");
  assert.ok(p.lexicalDiversity > 0 && p.lexicalDiversity <= 1);
  assert.ok(p.contractions, "sample uses contractions");
  assert.ok(p.hedging, "sample uses hedging");
  assert.ok(p.firstPerson, "sample is first person");
  assert.ok(p.domainTerms.length > 0, "domain terms extracted");
});

test("stylePrompt produces actionable modifiers", () => {
  const p = captureStyleProfile([SAMPLE]);
  const prompt = stylePrompt(p);
  assert.ok(prompt.includes("sentence length"));
  assert.ok(prompt.includes("contractions"));
  assert.ok(prompt.includes("first person"));
});

test("withStyle appends to existing system prompt", () => {
  const p = captureStyleProfile([SAMPLE]);
  const base = "You are a helpful coach.";
  const result = withStyle(base, p);
  assert.ok(result.startsWith(base), "base prompt preserved");
  assert.ok(result.includes("Style guide"));
});

test("withStyle is a no-op without a profile", () => {
  const base = "You are a helpful coach.";
  assert.equal(withStyle(base, undefined), base);
});

test("serialize/deserialize round-trips", () => {
  const p = captureStyleProfile([SAMPLE]);
  const json = serializeProfile(p);
  const restored = deserializeProfile(json);
  assert.ok(restored);
  assert.equal(restored!.avgSentenceLength, p.avgSentenceLength);
  assert.equal(restored!.lexicalDiversity, p.lexicalDiversity);
  assert.equal(restored!.contractions, p.contractions);
});
