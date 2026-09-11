import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUtterance, isCoachWorthy } from "./utterance.js";

test("questions: interrogatives, question words, and imperative asks", () => {
  assert.equal(classifyUtterance("Tell me about yourself?"), "question");
  assert.equal(classifyUtterance("How would you evaluate an AI response?"), "question");
  assert.equal(classifyUtterance("Walk me through a time you debugged production"), "question");
  assert.equal(classifyUtterance("Describe your experience with LLMs"), "question");
  assert.equal(classifyUtterance("Tell me about your background"), "question");
});

test("greetings greet back — never treated as junk", () => {
  assert.equal(classifyUtterance("Hi Zara"), "greeting");
  assert.equal(classifyUtterance("Hello! Good morning"), "greeting");
  assert.equal(classifyUtterance("Hey, how are you doing today?"), "greeting");
  assert.equal(classifyUtterance("Nice to meet you"), "greeting");
  assert.ok(isCoachWorthy("greeting"));
});

test("clarifications route to re-explain, not to the draft grill", () => {
  assert.equal(classifyUtterance("Sorry, can you repeat that?"), "clarification");
  assert.equal(classifyUtterance("What do you mean by tokenization?"), "clarification");
  assert.equal(classifyUtterance("I didn't quite catch that"), "clarification");
  assert.equal(classifyUtterance("Could you clarify the question?"), "clarification");
});

test("statements bridge, never grill", () => {
  assert.equal(classifyUtterance("We're looking for someone who can hit the ground running"), "statement");
  assert.equal(classifyUtterance("This role involves a lot of cross-team work with data engineers"), "statement");
  assert.ok(isCoachWorthy("statement"));
});

test("backchannel is the ONLY type that never wakes the coach", () => {
  assert.equal(classifyUtterance("mm-hm"), "backchannel");
  assert.equal(classifyUtterance("Interesting"), "backchannel");
  assert.equal(classifyUtterance("okay"), "backchannel");
  assert.equal(classifyUtterance(""), "backchannel");
  assert.equal(isCoachWorthy("backchannel"), false);
});
