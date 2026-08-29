/**
 * Embedding pipeline — port of rival `rag/EmbeddingPipeline.ts` semantics
 * (chunk → embed → retry/fallback) with a free-first provider choice:
 * the lexical hashed embedder needs no keys and no models; an
 * OpenAI-compatible embeddings endpoint slots in when configured.
 */
import { createHash } from "node:crypto";

export const EMBED_DIM = 256;
const CHUNK_CHARS = 800;
const CHUNK_OVERLAP = 100;

export interface TranscriptInput {
  sequenceNo: number;
  text: string;
}

export interface Chunk {
  text: string;
  firstSeq: number;
  lastSeq: number;
}

/** Merge transcript lines into overlapping ~800-char chunks (rival parity). */
export function chunkTranscript(
  segments: TranscriptInput[],
  opts: { chunkChars?: number; overlap?: number } = {},
): Chunk[] {
  const chunkChars = opts.chunkChars ?? CHUNK_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const lines = segments
    .map((s) => ({ seq: s.sequenceNo, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
  const chunks: Chunk[] = [];
  let current: { seq: number; text: string }[] = [];
  let length = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      text: current.map((c) => c.text).join("\n"),
      firstSeq: current[0]!.seq,
      lastSeq: current[current.length - 1]!.seq,
    });
    // Keep the tail as overlap context for the next chunk.
    const tailText = current.map((c) => c.text).join("\n").slice(-overlap);
    current = tailText.length > 0 ? [{ seq: current[current.length - 1]!.seq, text: tailText }] : [];
    length = tailText.length;
  };

  for (const line of lines) {
    current.push(line);
    length += line.text.length + 1;
    if (length >= chunkChars) flush();
  }
  flush();
  return chunks;
}

export interface EmbeddingProvider {
  readonly dim: number;
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic hashed bag-of-words embedding (dim 256, L2-normalized).
 * Lexical, not semantic — free, offline, and stable for recall demos and
 * tests; replaced by a real model the moment an embeddings endpoint exists.
 */
export class LexicalHashEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  readonly id = "lexical-hash";

  constructor(dim = EMBED_DIM) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
      const h = createHash("sha1").update(token).digest();
      const idx = ((h[0]! << 8) | h[1]!) % this.dim;
      const sign = (h[2]! & 1) === 0 ? 1 : -1;
      vec[idx]! += sign;
    }
    return l2normalize(vec);
  }
}

/** Any OpenAI-compatible `/v1/embeddings` endpoint (OpenAI, local servers). */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number;
  readonly id: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    dim = EMBED_DIM,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.dim = dim;
    this.id = `openai-compat:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const body = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) throw new Error("embedding count mismatch");
    return data.map((d) => l2normalize(d.embedding));
  }
}

/** Free-first choice: cloud embeddings only when explicitly configured. */
export function createEmbeddingProvider(opts: {
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDim?: number;
}): EmbeddingProvider {
  if (opts.embeddingBaseUrl && opts.embeddingApiKey && opts.embeddingModel) {
    return new OpenAICompatibleEmbeddingProvider(
      opts.embeddingBaseUrl,
      opts.embeddingApiKey,
      opts.embeddingModel,
      opts.embeddingDim ?? EMBED_DIM,
    );
  }
  return new LexicalHashEmbeddingProvider();
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}
