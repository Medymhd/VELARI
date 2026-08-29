/**
 * PgVector store — rival `rag/VectorStore` + `EmbeddingPipeline` persistence
 * semantics on Postgres (Option A: keep our tenant database, gain pgvector).
 * Embeddings ride raw SQL; everything else stays Prisma.
 *
 * Note: Prisma raw params arrive as TEXT — `session_id`/`id` columns are
 * TEXT (String in schema) so they compare directly; only the vector param
 * needs an explicit CAST.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const vec = (v: number[]): string => `[${v.join(",")}]`;

export interface StoredChunk {
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface RecallHit {
  chunkIndex: number;
  text: string;
  score: number;
}

export async function replaceChunks(
  db: PrismaClient,
  sessionId: string,
  chunks: StoredChunk[],
): Promise<number> {
  await db.$executeRaw`DELETE FROM session_chunks WHERE session_id = ${sessionId}`;
  for (const chunk of chunks) {
    await db.$executeRaw`
      INSERT INTO session_chunks (id, session_id, chunk_index, text, embedding, status, retry_count)
      VALUES (
        ${randomUUID()},
        ${sessionId},
        ${chunk.chunkIndex},
        ${chunk.text},
        CAST(${vec(chunk.embedding)} AS vector),
        'ready',
        0
      )`;
  }
  return chunks.length;
}

export async function vectorRecall(
  db: PrismaClient,
  sessionId: string,
  queryVec: number[],
  limit: number,
): Promise<RecallHit[]> {
  const rows = await db.$queryRaw<{ chunk_index: number; text: string; sim: number }[]>`
    SELECT chunk_index, text, 1 - (embedding <=> CAST(${vec(queryVec)} AS vector)) AS sim
    FROM session_chunks
    WHERE session_id = ${sessionId} AND embedding IS NOT NULL
    ORDER BY embedding <=> CAST(${vec(queryVec)} AS vector)
    LIMIT ${limit}`;
  return rows.map((r) => ({ chunkIndex: Number(r.chunk_index), text: r.text, score: Number(r.sim) }));
}

export async function lexicalRecall(
  db: PrismaClient,
  sessionId: string,
  query: string,
  limit: number,
): Promise<RecallHit[]> {
  // Escape LIKE wildcards so query punctuation stays literal.
  const like = `%${query.replace(/[%_\\]/g, "")}%`;
  const rows = await db.$queryRaw<{ chunk_index: number; text: string }[]>`
    SELECT chunk_index, text
    FROM session_chunks
    WHERE session_id = ${sessionId} AND text ILIKE ${like}
    ORDER BY chunk_index
    LIMIT ${limit}`;
  return rows.map((r) => ({ chunkIndex: Number(r.chunk_index), text: r.text, score: 1 }));
}

/** Hybrid: 0.7 × vector similarity + 0.3 × lexical hit, best per chunk. */
export function mergeRecall(vector: RecallHit[], lexical: RecallHit[]): RecallHit[] {
  const byChunk = new Map<number, RecallHit>();
  for (const hit of vector) {
    const merged = byChunk.get(hit.chunkIndex);
    const score = 0.7 * hit.score;
    if (!merged || score > merged.score) byChunk.set(hit.chunkIndex, { ...hit, score });
  }
  for (const hit of lexical) {
    const merged = byChunk.get(hit.chunkIndex);
    if (merged) merged.score = Math.min(1, merged.score + 0.3);
    else byChunk.set(hit.chunkIndex, { ...hit, score: 0.3 });
  }
  return [...byChunk.values()].sort((a, b) => b.score - a.score);
}

/** Query↔chunk word-overlap ratio in [0,1] — the reranking signal. */
export function overlapScore(query: string, text: string): number {
  const tokenize = (s: string) =>
    new Set(
      (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((t) => t.length > 2),
    );
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const t = tokenize(text);
  let hits = 0;
  for (const token of q) if (t.has(token)) hits += 1;
  return hits / q.size;
}

/**
 * Rerank merged hits by query-chunk overlap (rival `localReranker` parity).
 * The seam accepts an external cross-encoder later; this lexical reranker
 * needs no model and beats vector-only ordering on keyword precision.
 */
export function rerankHits(
  query: string,
  hits: RecallHit[],
  opts: { overlapWeight?: number } = {},
): RecallHit[] {
  const overlapWeight = opts.overlapWeight ?? 0.35;
  return hits
    .map((h) => ({
      ...h,
      score: Math.min(1, h.score * (1 - overlapWeight) + overlapWeight * overlapScore(query, h.text)),
    }))
    .sort((a, b) => b.score - a.score);
}
