import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkTranscript,
  cosineSimilarity,
  createEmbeddingProvider,
  LexicalHashEmbeddingProvider,
} from "./embeddings.js";

test("chunkTranscript merges lines to ~chunkChars with overlap and seq bounds", () => {
  const segments = Array.from({ length: 40 }, (_, i) => ({
    sequenceNo: i + 1,
    text: `segment ${i + 1} ${"word ".repeat(20)}`,
  }));
  const chunks = chunkTranscript(segments, { chunkChars: 800, overlap: 100 });
  assert.ok(chunks.length >= 2, "long transcript produces multiple chunks");
  for (const c of chunks) {
    assert.ok(c.text.length >= 100, "chunks carry content");
    assert.ok(c.firstSeq <= c.lastSeq);
  }
  assert.equal(chunks[0]!.firstSeq, 1);
  assert.equal(chunks.at(-1)!.lastSeq, 40);
});

test("lexical embeddings are deterministic, normalized, and discriminative", async () => {
  const p = new LexicalHashEmbeddingProvider();
  const [a, b, again] = await p.embed(["conflict with a stakeholder", "deploying kubernetes clusters", "conflict with a stakeholder"]);
  assert.deepEqual(a, again, "deterministic");
  const norm = Math.sqrt(a!.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, "L2 normalized");
  assert.ok(cosineSimilarity(a!, b!) < 0.5, "different topics stay apart");
});

test("cosine similarity anchors: identical=1, orthogonal≈0, empty=0", async () => {
  const p = new LexicalHashEmbeddingProvider();
  const [a, b] = await p.embed(["same words here", "same words here"]);
  assert.ok(Math.abs(cosineSimilarity(a!, b!) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("createEmbeddingProvider falls back to lexical without config (free-first)", async () => {
  assert.equal(createEmbeddingProvider({}).id, "lexical-hash");
  const cloud = createEmbeddingProvider({
    embeddingBaseUrl: "https://api.example/v1",
    embeddingApiKey: "k",
    embeddingModel: "text-embedding-3-small",
  });
  assert.equal(cloud.id, "openai-compat:text-embedding-3-small");
});
