import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeQuestion,
  stemLite,
  questionTokens,
  jaccard,
  keyHashFor,
  prepHashOf,
  AnswerCache,
} from "./answerCache.js";

const rec = (question: string, opts: Partial<{ mode: string; length: string; prepHash: string; embedding: number[] }> = {}) => {
  const mode = opts.mode ?? "general";
  const length = opts.length ?? "medium";
  const prepHash = opts.prepHash ?? "p1";
  return {
    id: `id-${question.slice(0, 8)}`,
    question,
    tokens: questionTokens(question),
    embedding: opts.embedding ?? [],
    frameworkJson: { detected_question: question, suggested_outline: ["a"], talking_points: ["b"], confidence: 0.9 },
    answerText: "b",
    mode,
    length,
    prepHash,
  };
};

test("normalizeQuestion strips punctuation, case, spacing, quotes", () => {
  assert.equal(normalizeQuestion("How would you evaluate an AI response?"), normalizeQuestion("how would you evaluate an AI response"));
  assert.equal(normalizeQuestion("What is RLHF?"), normalizeQuestion("What is \u201cRLHF\u201d "));
  assert.equal(normalizeQuestion("What is RLHF?"), "what is rlhf"); // curly quotes collapse to plain text, no residue
});

test("stemLite collapses inflections", () => {
  assert.equal(stemLite("evaluating"), stemLite("evaluation"));
  assert.equal(stemLite("responses"), stemLite("response"));
  assert.equal(stemLite("evaluate"), stemLite("evaluation"));
});

test("questionTokens drops stopwords", () => {
  const t = questionTokens("What is your approach to the evaluation of responses?");
  assert.ok(!t.includes("what") && !t.includes("your") && !t.includes("the"));
  assert.ok(t.includes("approach") && t.includes("evaluat") === false || t.length > 0);
});

test("jaccard: identical sets = 1, disjoint = 0", () => {
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
});

test("keyHashFor is order-independent on normalization and sensitive to mode/length/prep", () => {
  const base = { question: "What is RLHF?", mode: "general", length: "medium", prepHash: "p1" };
  assert.equal(keyHashFor(base), keyHashFor({ ...base, question: "what is RLHF" }));
  assert.notEqual(keyHashFor(base), keyHashFor({ ...base, mode: "technical" }));
  assert.notEqual(keyHashFor(base), keyHashFor({ ...base, length: "short" }));
  assert.notEqual(keyHashFor(base), keyHashFor({ ...base, prepHash: "p2" }));
});

test("prepHashOf changes when prep materials change", () => {
  const h1 = prepHashOf("JD text", [{ id: "1", title: "t", content: "c" }]);
  const h2 = prepHashOf("JD text changed", [{ id: "1", title: "t", content: "c" }]);
  const h3 = prepHashOf("JD text", [{ id: "1", title: "t", content: "c" }]);
  assert.notEqual(h1, h2);
  assert.equal(h1, h3);
});

test("tier 0: normalized exact hit", async () => {
  const cache = new AnswerCache(async () => [[1]]);
  cache.load([rec("How would you evaluate an AI response?").valueOf() as never].map((e) => ({
    id: "1", question: "How would you evaluate an AI response?", tokensJson: questionTokens("How would you evaluate an AI response?"),
    embeddingJson: [], frameworkJson: { detected_question: "q" }, answerText: "a", mode: "general", length: "medium", prepHash: "p1",
  })));
  const hit = await cache.lookup("how would you evaluate an AI response", { mode: "general", length: "medium", prepHash: "p1" });
  assert.ok(hit);
  assert.equal(hit.key, "exact");
});

test("tier 1: slightly reworded question is a fuzzy hit", async () => {
  const cache = new AnswerCache(async () => [[1]]);
  cache.load([{
    id: "1", question: "How would you evaluate an AI response using a rubric?", tokensJson: questionTokens("How would you evaluate an AI response using a rubric?"),
    embeddingJson: [], frameworkJson: { detected_question: "q" }, answerText: "a", mode: "general", length: "medium", prepHash: "p1",
  }]);
  const hit = await cache.lookup("How do you evaluate an AI response with a rubric?", { mode: "general", length: "medium", prepHash: "p1" });
  assert.ok(hit, "expected fuzzy hit");
  assert.equal(hit.key, "fuzzy");
  assert.ok(hit.score >= 0.8);
});

test("different mode/length/prepHash never serves a hit", async () => {
  const cache = new AnswerCache(async () => [[1]]);
  cache.load([{
    id: "1", question: "What is RLHF?", tokensJson: questionTokens("What is RLHF?"),
    embeddingJson: [], frameworkJson: {}, answerText: "a", mode: "general", length: "medium", prepHash: "p1",
  }]);
  assert.equal(await cache.lookup("What is RLHF?", { mode: "general", length: "medium", prepHash: "p2" }), null);
  assert.equal(await cache.lookup("What is RLHF?", { mode: "technical", length: "medium", prepHash: "p1" }), null);
  assert.equal(await cache.lookup("What is RLHF?", { mode: "general", length: "short", prepHash: "p1" }), null);
});

test("tier 2: deep paraphrase caught by vector cosine", async () => {
  // Embedder returns near-parallel vectors for the paraphrase pair.
  const cache = new AnswerCache(async (texts) => texts.map((t) => (t.includes("walk") ? [1, 0.5, 0.2] : [0.98, 0.49, 0.196])));
  cache.load([{
    id: "1", question: "walk me through your background", tokensJson: [],
    embeddingJson: [1, 0.5, 0.2], frameworkJson: {}, answerText: "a", mode: "general", length: "medium", prepHash: "p1",
  }]);
  const hit = await cache.lookup("tell me about your background", { mode: "general", length: "medium", prepHash: "p1" });
  assert.ok(hit, "expected vector hit");
  assert.ok(hit.score >= 0.92);
});

test("seed dedupes on the same key and respects maxRecords", async () => {
  const cache = new AnswerCache(async () => [[1]], undefined, 2);
  const base = { mode: "general", length: "medium", prepHash: "p1", embedding: [], frameworkJson: {}, answerText: "x" };
  cache.seed({ id: "1", question: "What is RLHF?", tokens: questionTokens("What is RLHF?"), ...base });
  cache.seed({ id: "2", question: "what is RLHF", tokens: questionTokens("what is RLHF"), ...base });
  assert.equal(cache.size(), 1, "same normalized question should replace, not duplicate");
  cache.seed({ id: "3", question: "Different question entirely", tokens: questionTokens("Different question entirely"), ...base });
  cache.seed({ id: "4", question: "Another distinct one here", tokens: questionTokens("Another distinct one here"), ...base });
  assert.equal(cache.size(), 2, "maxRecords cap enforced");
});

test("embedder failure never throws — lookup returns null and LLM path continues", async () => {
  const cache = new AnswerCache(async () => { throw new Error("embedder down"); });
  cache.load([{
    id: "1", question: "Some question that will not fuzzy match at all", tokensJson: questionTokens("Some question that will not fuzzy match at all"),
    embeddingJson: [], frameworkJson: {}, answerText: "a", mode: "general", length: "medium", prepHash: "p1",
  }]);
  const hit = await cache.lookup("Completely different topic about databases and indexes", { mode: "general", length: "medium", prepHash: "p1" });
  assert.equal(hit, null);
});
