import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnswerCache, containment, jaccard, questionTokens } from "./answerCache.js";

describe("answerCache matching", () => {
  const PREP = "p1";
  const opts = { mode: "general", length: "medium", prepHash: PREP };

  it("stopword fix: tell/about survive as content tokens", () => {
    const t = questionTokens("Tell me about yourself in details?");
    assert.ok(t.includes("tell"), "'tell' must be content");
    assert.ok(t.includes("about"), "'about' must be content");
    assert.ok(t.includes("yourself"));
  });

  it("containment scores subset phrasings high", () => {
    const a = questionTokens("tell me about yourself in details");
    const b = questionTokens("Tell us about yourself.");
    assert.ok(containment(a, b) >= 0.65, `containment ${containment(a, b)} should be >= 0.65`);
  });

  it("the field failure: paraphrase + detail suffix serves from cache", async () => {
    const cache = new AnswerCache(async (texts) => texts.map(() => []));
    cache.load([
      {
        id: "e1",
        question: "Tell us about yourself.",
        tokensJson: questionTokens("Tell us about yourself."),
        embeddingJson: [],
        frameworkJson: { detected_question: "Tell us about yourself.", suggested_outline: [], talking_points: ["I am Ahmed"] },
        answerText: "I am Ahmed",
        mode: "general",
        length: "medium",
        prepHash: PREP,
      },
    ]);
    const hit = await cache.lookup("tell me about yourself in details?", opts);
    assert.ok(hit, "paraphrase + detail suffix must hit the fuzzy tier");
    assert.equal(hit!.matchedQuestion, "Tell us about yourself.");
  });

  it("no false positives across unrelated questions", async () => {
    const cache = new AnswerCache(async (texts) => texts.map(() => []));
    cache.load([
      {
        id: "e2",
        question: "Tell me about your greatest weakness.",
        tokensJson: questionTokens("Tell me about your greatest weakness."),
        embeddingJson: [],
        frameworkJson: { detected_question: "weakness" },
        answerText: "procrastination",
        mode: "general",
        length: "medium",
        prepHash: PREP,
      },
    ]);
    const hit = await cache.lookup("tell me about yourself in details?", opts);
    assert.equal(hit, null, "yourself vs weakness must NOT match");
  });

  it("jaccard sanity: identical questions score 1", () => {
    const q = questionTokens("why micro1");
    assert.equal(jaccard(q, q), 1);
  });
});
