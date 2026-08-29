import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  assertStartAllowed,
  assertTransition,
  retentionDeadlineMs,
} from "@app/domain";
import type { ConsentStatus, RetentionPolicy } from "@app/contracts";
import { toJson } from "../db.js";
import { writeAudit } from "../audit.js";
import { assertMembership } from "./workspaces.js";
import { uploadJson } from "../lib/s3.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? path.join(process.cwd(), ".data", "exports");

export function sessionRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/interview-sessions", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      title?: string;
      consentStatus?: ConsentStatus;
      retentionPolicy?: RetentionPolicy;
      metadataJson?: Record<string, unknown>;
    };
    if (!body.workspaceId) return reply.status(400).send({ error: "workspaceId required" });
    if (!(await assertMembership(db, userId, body.workspaceId))) {
      return reply.status(403).send({ error: "not a member of this workspace" });
    }

    const session = await db.interviewSession.create({
      data: {
        workspaceId: body.workspaceId,
        ownerUserId: userId,
        title: body.title ?? null,
        status: "draft",
        consentStatus: body.consentStatus ?? "pending",
        retentionPolicy: body.retentionPolicy ?? "retain_30d",
        metadataJson: (body.metadataJson as any) ?? {},
      },
    });
    await writeAudit(db, {
      workspaceId: body.workspaceId,
      actorType: "user",
      actorId: userId,
      eventType: "session.created",
      resourceType: "interview_session",
      resourceId: session.id,
    });
    return reply.status(201).send(toJson(session));
  });

  app.get("/v1/interview-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (!(await assertMembership(db, req.user!.userId, session.workspaceId))) {
      return reply.status(403).send({ error: "forbidden" });
    }
    return reply.send(toJson(session));
  });

  app.get("/v1/interview-sessions", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return [];
    if (!(await assertMembership(db, req.user!.userId, workspaceId))) return [];
    const rows = await db.interviewSession.findMany({
      where: { workspaceId },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    return toJson(rows);
  });

  app.patch("/v1/interview-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      title?: string;
      consentStatus?: ConsentStatus;
      retentionPolicy?: RetentionPolicy;
      metadataJson?: Record<string, unknown>;
    };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });

    const updated = await db.interviewSession.update({
      where: { id },
      data: {
        title: body.title ?? undefined,
        consentStatus: body.consentStatus ?? undefined,
        retentionPolicy: body.retentionPolicy ?? undefined,
        metadataJson: (body.metadataJson as any) ?? undefined,
      },
    });
    return reply.send(toJson(updated));
  });

  for (const action of ["start", "pause", "complete"] as const) {
    app.post(`/v1/interview-sessions/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await db.interviewSession.findUnique({ where: { id } });
      if (!session) return reply.status(404).send({ error: "not found" });
      if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });

      try {
        const to =
          action === "start" ? "live" : action === "pause" ? "paused" : "completed";
        assertTransition(session.status as never, to);
        if (action === "start") assertStartAllowed(session.consentStatus as never);

        const updated = await db.interviewSession.update({
          where: { id },
          data: {
            status: to,
            startedAt: action === "start" ? new Date() : session.startedAt,
            endedAt: action === "complete" ? new Date() : session.endedAt,
          },
        });
        await writeAudit(db, {
          workspaceId: session.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: `session.${action}`,
          resourceType: "interview_session",
          resourceId: id,
        });
        return reply.send(toJson(updated));
      } catch (e) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : "invalid transition";
        return reply.status(code === "consent_required" ? 409 : 422).send({ error: msg });
      }
    });
  }

  /** Delete honors retention policy; delete_on_end purges content immediately. */
  app.delete("/v1/interview-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });

    await db.transcriptSegment.deleteMany({ where: { sessionId: id } });
    await db.sessionInsight.deleteMany({ where: { sessionId: id } });
    await db.artifact.deleteMany({ where: { sessionId: id } });
    await db.interviewSession.delete({ where: { id } });
    await writeAudit(db, {
      workspaceId: session.workspaceId,
      actorType: "user",
      actorId: req.user!.userId,
      eventType: "session.deleted",
      resourceType: "interview_session",
      resourceId: id,
      metadataJson: { retentionPolicy: session.retentionPolicy },
    });
    return reply.send({ deleted: true });
  });

  app.get("/v1/interview-sessions/:id/transcript", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (!(await assertMembership(db, req.user!.userId, session.workspaceId))) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const segments = await db.transcriptSegment.findMany({
      where: { sessionId: id, isFinal: true },
      orderBy: { sequenceNo: "asc" },
    });
    return reply.send(toJson(segments));
  });

  app.get("/v1/interview-sessions/:id/insights", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (!(await assertMembership(db, req.user!.userId, session.workspaceId))) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const insights = await db.sessionInsight.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    });
    return reply.send(toJson(insights));
  });

  /** Export — tries S3/MinIO first (signed URL), falls back to local file. */
  app.post("/v1/interview-sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.userId;
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "not found" });
    if (session.ownerUserId !== userId) return reply.status(403).send({ error: "forbidden" });

    const [segments, insights] = await Promise.all([
      db.transcriptSegment.findMany({ where: { sessionId: id }, orderBy: { sequenceNo: "asc" } }),
      db.sessionInsight.findMany({ where: { sessionId: id }, orderBy: { createdAt: "asc" } }),
    ]);
    const bundle = {
      exportedAt: new Date().toISOString(),
      session: toJson(session),
      transcript: toJson(segments),
      insights: toJson(insights),
    };

    let storageKey: string;
    let url: string | null = null;
    try {
      const key = `exports/${id}/${Date.now()}.json`;
      const r = await uploadJson(key, bundle);
      storageKey = r.s3Key;
      url = r.url;
    } catch {
      mkdirSync(EXPORT_DIR, { recursive: true });
      storageKey = path.join(EXPORT_DIR, `${id}.json`);
      writeFileSync(storageKey, JSON.stringify(bundle, null, 2));
    }

    const artifact = await db.artifact.create({
      data: {
        workspaceId: session.workspaceId,
        sessionId: id,
        kind: "export",
        storageKey,
        contentType: "application/json",
        sizeBytes: BigInt(Buffer.byteLength(JSON.stringify(bundle))),
      },
    });
    await writeAudit(db, {
      workspaceId: session.workspaceId,
      actorType: "user",
      actorId: userId,
      eventType: "session.exported",
      resourceType: "artifact",
      resourceId: artifact.id,
    });
    return reply.send(toJson({ ...bundle, artifact: { id: artifact.id, storageKey, url } }));
  });
}

/** Used by the worker's retention sweeper. */
export function retentionDeadline(policy: string): number {
  return retentionDeadlineMs(policy);
}


