/**
 * Session vector recall (§5.1 P3): reindex a session's final transcript into
 * pgvector chunks; hybrid (vector + lexical) recall for the coach context.
 * Embeddings default to the free lexical provider — cloud slots in via env.
 */
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  chunkTranscript,
  createEmbeddingProvider,
  type TranscriptInput,
} from "@app/ai-runtime";
import { replaceChunks, vectorRecall, lexicalRecall, mergeRecall, rerankHits } from "../rag/store.js";
import { writeAudit } from "../audit.js";
import { logger } from "@app/observability";

const log = logger({ svc: "recall" });

interface RecallQuery {
  q?: string;
}

async function canAccess(db: PrismaClient, sessionId: string, userId: string): Promise<string | null> {
  const session = await db.interviewSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.ownerUserId === userId) return session.workspaceId;
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: session.workspaceId, userId } },
  });
  return member ? session.workspaceId : null;
}

export function recallRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/interview-sessions/:id/reindex", async (req, reply) => {
    const userId = req.user!.userId;
    const { id } = req.params as { id: string };
    const workspaceId = await canAccess(db, id, userId);
    if (!workspaceId) return reply.status(404).send({ error: "session not found" });

    const segments = await db.transcriptSegment.findMany({
      where: { sessionId: id, isFinal: true },
      orderBy: { sequenceNo: "asc" },
    });
    const input: TranscriptInput[] = segments.map((s) => ({ sequenceNo: s.sequenceNo, text: s.text }));
    const chunks = chunkTranscript(input);

    const provider = createEmbeddingProvider({
      embeddingBaseUrl: process.env.EMBEDDING_BASE_URL,
      embeddingApiKey: process.env.EMBEDDING_API_KEY,
      embeddingModel: process.env.EMBEDDING_MODEL,
    });
    const embeddings = await provider.embed(chunks.map((c) => c.text));
    const count = await replaceChunks(
      db,
      id,
      chunks.map((c, i) => ({ chunkIndex: i, text: c.text, embedding: embeddings[i]! })),
    );

    await writeAudit(db, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      eventType: "session.reindexed",
      resourceType: "interview_session",
      resourceId: id,
      metadataJson: { chunks: count, provider: provider.id },
    });
    log.info("session reindexed", { sessionId: id, chunks: count, provider: provider.id });
    return { ok: true, chunks: count, provider: provider.id };
  });

  app.get("/v1/interview-sessions/:id/recall", async (req, reply) => {
    const userId = req.user!.userId;
    const { id } = req.params as { id: string };
    const { q } = req.query as RecallQuery;
    const query = (q ?? "").trim();
    if (!query) return reply.status(400).send({ error: "q is required" });
    const workspaceId = await canAccess(db, id, userId);
    if (!workspaceId) return reply.status(404).send({ error: "session not found" });

    const provider = createEmbeddingProvider({
      embeddingBaseUrl: process.env.EMBEDDING_BASE_URL,
      embeddingApiKey: process.env.EMBEDDING_API_KEY,
      embeddingModel: process.env.EMBEDDING_MODEL,
    });
    const [queryVec] = await provider.embed([query]);
    const [vector, lexical] = await Promise.all([
      vectorRecall(db, id, queryVec!, 12),
      lexicalRecall(db, id, query, 8),
    ]);
    return { ok: true, hits: rerankHits(query, mergeRecall(vector, lexical)).slice(0, 8) };
  });
}
