import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoachMessages, buildAnswerMessages, offlineFramework } from "./prompts.js";

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

test("answer prompt: two-field JSON contract with question classification", () => {
  const msgs = buildAnswerMessages({ detectedQuestion: "What makes good training data?", transcriptTail: "q" });
  const system = msgs[0]!.content as string;
  assert.match(system, /QUESTION CLASSIFICATION/);
  assert.match(system, /GENERAL/);
  assert.match(system, /EXPERIENCE/);
  assert.match(system, /HYBRID/);
  assert.match(system, /\{"answer": string, "grounding": string\}/);
  // General questions must not open with the persona: vocative openers banned.
  assert.match(system, /vocative openers are BANNED/);
});

test("answer prompt: CV/JD labeled source-of-truth, persona rides along", () => {
  const msgs = buildAnswerMessages({
    detectedQuestion: "How did you improve model quality?",
    transcriptTail: "tail",
    prepContext: "CV (me.docx):\nBuilt evaluation rubrics",
    personaContext: "Role: AI Training Specialist",
  });
  const user = msgs[1]!.content as string;
  assert.match(user, /CANDIDATE CV \/ JOB DESCRIPTION/);
  assert.match(user, /Built evaluation rubrics/);
  assert.match(user, /Role: AI Training Specialist/);
  assert.match(user, /do NOT force them into definitional answers/);
});

test("answer prompt: grounding contract caps and transitions", () => {
  const msgs = buildAnswerMessages({ detectedQuestion: "What is RLHF?", transcriptTail: "q" });
  const system = msgs[0]!.content as string;
  assert.match(system, /under 60 words/);
  assert.match(system, /no grounding is better than forced grounding/);
});
