/**
 * Annotation routes (valeriworkvertical.md §8) — multimodal labels with
 * human QC and inter-rater agreement. Tenancy-gated like every other route.
 */
import type { PrismaClient } from "@prisma/client";
import type { RouteRegistrar, ReplyLike } from "@app/agent-sdk";
import { krippendorffAlpha } from "./agreement.js";

interface RequestLike {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  user?: { userId: string };
}

const KINDS = new Set(["text", "image", "video", "audio", "document"]);
const ORIGINS = new Set(["human", "ai_pre_label"]);

async function canAccess(db: PrismaClient, workspaceId: string, userId: string): Promise<boolean> {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return Boolean(member);
}

export function registerAnnotationRoutes(
  register: RouteRegistrar,
  db: PrismaClient,
): void {
  // POST /annotations — add a label on a unit of a task.
  register.post("/annotations", async (rawReq: unknown, reply: ReplyLike) => {
    const req = rawReq as RequestLike;
    const body = req.body ?? {};
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!taskId) return reply.status(400).send({ error: "taskId required" });
    const task = await db.workTask.findUnique({ where: { id: taskId } });
    if (!task) return reply.status(404).send({ error: "task not found" });
    if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
      return reply.status(403).send({ error: "not a workspace member" });
    }
    const kind = typeof body.kind === "string" ? body.kind : "text";
    if (!KINDS.has(kind)) return reply.status(400).send({ error: `invalid kind: ${kind}` });
    const label = typeof body.label === "string" ? body.label : "";
    if (!label) return reply.status(400).send({ error: "label required" });
    const origin = typeof body.origin === "string" ? body.origin : "human";
    if (!ORIGINS.has(origin)) return reply.status(400).send({ error: `invalid origin: ${origin}` });
    const confidence = typeof body.confidence === "number" ? body.confidence : null;

    const annotation = await db.workAnnotation.create({
      data: {
        workspaceId: task.workspaceId,
        taskId,
        unit: typeof body.unit === "string" ? body.unit : "",
        kind,
        label,
        labelData: (body.labelData ?? {}) as any,
        confidence,
        origin,
      },
    });
    return reply.status(201).send({ annotation });
  });

  // GET /annotations?taskId= — list labels for a task.
  register.get("/annotations", async (rawReq: unknown, reply: ReplyLike) => {
    const req = rawReq as RequestLike & { query?: { taskId?: string } };
    const taskId = req.query?.taskId ?? "";
    if (!taskId) return reply.status(400).send({ error: "taskId required" });
    const task = await db.workTask.findUnique({ where: { id: taskId } });
    if (!task) return reply.status(404).send({ error: "task not found" });
    if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
      return reply.status(403).send({ error: "not a workspace member" });
    }
    const annotations = await db.workAnnotation.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" },
    });
    return reply.send({ annotations });
  });

  // POST /annotations/:id/review — human QC: approve or correct a label.
  register.post("/annotations/:id/review", async (rawReq: unknown, reply: ReplyLike) => {
    const req = rawReq as RequestLike;
    const id = req.params?.id ?? "";
    const body = req.body ?? {};
    const annotation = await db.workAnnotation.findUnique({ where: { id } });
    if (!annotation) return reply.status(404).send({ error: "annotation not found" });
    if (!(await canAccess(db, annotation.workspaceId, req.user!.userId))) {
      return reply.status(403).send({ error: "not a workspace member" });
    }
    const decision = body.decision === "rejected" ? "rejected" : "approved";
    const finalLabel = typeof body.finalLabel === "string" && body.finalLabel ? body.finalLabel : null;
    const updated = await db.workAnnotation.update({
      where: { id },
      data: {
        status: decision,
        reviewedBy: req.user!.userId,
        finalLabel: decision === "approved" ? (finalLabel ?? annotation.label) : finalLabel,
      },
    });
    return reply.send({ annotation: updated });
  });

  // GET /tasks/:taskId/annotation-agreement — inter-rater agreement (§8).
  register.get("/tasks/:taskId/annotation-agreement", async (rawReq: unknown, reply: ReplyLike) => {
    const req = rawReq as RequestLike;
    const taskId = req.params?.taskId ?? "";
    const task = await db.workTask.findUnique({ where: { id: taskId } });
    if (!task) return reply.status(404).send({ error: "task not found" });
    if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
      return reply.status(403).send({ error: "not a workspace member" });
    }
    const annotations = await db.workAnnotation.findMany({ where: { taskId } });

    // Group labels by unit key → units for Krippendorff's alpha.
    const byUnit = new Map<string, (string | null)[]>();
    for (const a of annotations) {
      const unit = (a.unit ?? "") || a.id;
      const row = byUnit.get(unit) ?? [];
      row.push(a.finalLabel ?? a.label);
      byUnit.set(unit, row);
    }
    const alpha = krippendorffAlpha([...byUnit.values()]);
    const pairableUnits = [...byUnit.values()].filter((r) => r.length >= 2).length;
    return reply.send({ ok: true, alpha, units: byUnit.size, pairableUnits, annotations: annotations.length });
  });
}
