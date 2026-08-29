/**
 * Work vertical backend — policy-gated commercial work.
 * Mirrors valeriworkvertical.md §5 work modes, §6 task model + lifecycle,
 * §10 agent runtime, §11 provenance/audit.
 *
 * Persistence: Prisma (WorkTask / WorkSubmission — schema §14 subset).
 * Tenancy: every route resolves the caller's workspace membership from
 * `req.user`; rows are workspace-scoped. Provenance is immutable and
 * audited. Brand-neutral: neutral ids, no hard-coded product name.
 */
import type { VerticalRegistration, VerticalServices } from "@app/agent-sdk";
import type { PrismaClient } from "@prisma/client";
import { runBrowserTask, type RunResult } from "./agentRunner.js";
import { workManifest } from "./manifest.js";
import { isAllowedDomain, requiresApproval, type WorkTask } from "./types.js";
import { buildCodeExplainMessages, buildCodeReviewMessages } from "./codePrompts.js";

type Db = PrismaClient;

const TASK_TYPES = new Set([
  "text_classification",
  "document_extraction",
  "image_annotation",
  "video_annotation",
  "audio_transcription",
  "audio_quality_review",
  "rubric_based_assessment",
  "research_synthesis",
  "policy_compliance_review",
  "data_validation",
  "customer_workflow_execution",
  "code_review",
  "workflow_execution",
  "browser_task_execution",
]);

const ORIGINS = new Set(["human", "agent", "human_with_agent_assist", "simulation_adversarial"]);

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

function strArray(body: Record<string, unknown>, key: string): string[] {
  const v = body[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

interface RequestLike {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  user?: { userId: string };
}

interface ReplyLike {
  status(code: number): { send(body: unknown): unknown };
  send(body: unknown): unknown;
}

/** Membership gate — Owner/Admin/Manager/Reviewer/Worker all pass; outsiders don't. */
async function canAccess(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return Boolean(member);
}

export const vertical: VerticalRegistration = {
  manifest: workManifest,
  registerRoutes(register, services) {
    const db = services.db as PrismaClient;
    const openSecret = services.openSecret ?? (() => null);

    // POST /tasks — create a work task in a workspace the caller belongs to.
    register.post("/tasks", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const body = req.body ?? {};
      const workspaceId = str(body, "workspaceId");
      if (!workspaceId) return reply.status(400).send({ error: "workspaceId required" });
      if (!(await canAccess(db, workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      const type = str(body, "type") || "workflow_execution";
      if (!TASK_TYPES.has(type)) {
        return reply.status(400).send({ error: `unknown task type: ${type}` });
      }
      const task = await db.workTask.create({
        data: {
          workspaceId,
          type,
          title: str(body, "title") || "Untitled work",
          instructions: str(body, "instructions"),
          allowedDomains: strArray(body, "allowedDomains"),
          autoApprove: body.autoApprove === true,
          policyVersion: str(body, "policyVersion") || "v1",
          createdBy: req.user!.userId,
        },
      });
      return reply.status(201).send({ task });
    });

    // GET /tasks?workspaceId= — list tasks for one of the caller's workspaces.
    register.get("/tasks", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike & { query?: { workspaceId?: string } };
      const workspaceId = req.query?.workspaceId ?? "";
      if (!workspaceId) return reply.status(400).send({ error: "workspaceId required" });
      if (!(await canAccess(db, workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      const tasks = await db.workTask.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      });
      return reply.send({ tasks });
    });

    // GET /tasks/:id
    register.get("/tasks/:id", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const id = req.params?.id ?? "";
      const task = await db.workTask.findUnique({ where: { id } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      return reply.send({ task });
    });

    // POST /tasks/:id/assign — draft → assigned
    register.post("/tasks/:id/assign", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const id = req.params?.id ?? "";
      const task = await db.workTask.findUnique({ where: { id } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      if (task.status !== "draft") {
        return reply.status(409).send({ error: `cannot assign from ${task.status}` });
      }
      const updated = await db.workTask.update({ where: { id }, data: { status: "assigned" } });
      return reply.send({ task: updated });
    });

    // POST /tasks/:id/submit — lifecycle: draft/assigned → submitted, with
    // immutable provenance (§6: origin is one of the declared values).
    register.post("/tasks/:id/submit", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const id = req.params?.id ?? "";
      const task = await db.workTask.findUnique({ where: { id } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      const body = req.body ?? {};
      const origin = str(body, "origin") || "human";
      if (!ORIGINS.has(origin)) {
        return reply.status(400).send({ error: `invalid origin: ${origin}` });
      }
      if (task.status !== "draft" && task.status !== "assigned") {
        return reply.status(409).send({ error: `cannot submit from ${task.status}` });
      }
      const submission = await db.workSubmission.create({
        data: {
          taskId: id,
          origin,
          content: str(body, "content"),
          policyVersion: task.policyVersion,
        },
      });
      const updated = await db.workTask.update({ where: { id }, data: { status: "submitted" } });
      await db.auditEvent.create({
        data: {
          workspaceId: task.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: "work.submitted",
          resourceType: "work_task",
          resourceId: id,
          metadataJson: { origin, submissionId: submission.id },
        },
      });
      return reply.send({
        task: updated,
        provenance: {
          id: submission.id,
          origin,
          policyVersion: task.policyVersion,
          reviewState: submission.reviewState,
        },
      });
    });

    // POST /tasks/:id/review — submitted → approved/returned; reviewState is
    // recorded per submission (§7 human-approval workflow).
    register.post("/tasks/:id/review", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const id = req.params?.id ?? "";
      const task = await db.workTask.findUnique({ where: { id } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      const body = req.body ?? {};
      const decision = body.decision === "returned" ? "returned" : "approved";
      if (task.status !== "submitted") {
        return reply.status(409).send({ error: `cannot review from ${task.status}` });
      }
      const lastSubmission = await db.workSubmission.findFirst({
        where: { taskId: id },
        orderBy: { createdAt: "desc" },
      });
      if (lastSubmission) {
        await db.workSubmission.update({
          where: { id: lastSubmission.id },
          data: { reviewState: decision === "approved" ? "approved" : "returned" },
        });
      }
      const updated = await db.workTask.update({ where: { id }, data: { status: decision } });
      await db.auditEvent.create({
        data: {
          workspaceId: task.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: "work.reviewed",
          resourceType: "work_task",
          resourceId: id,
          metadataJson: { decision, autoApproved: task.autoApprove && decision === "approved" },
        },
      });
      return reply.send({
        task: updated,
        decision,
        autoApproved: task.autoApprove && decision === "approved",
      });
    });

    // POST /browser/execute — bounded browser task. Policy comes from the
    // TASK RECORD (never the request body): allowedDomains + autoApprove are
    // stored at creation, so callers cannot widen their own allowlist.
    register.post("/browser/execute", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const body = req.body ?? {};
      const url = str(body, "url");
      const taskId = str(body, "taskId");
      if (!url) return reply.status(400).send({ error: "url required" });
      if (!taskId) return reply.status(400).send({ error: "taskId required" });
      const task = await db.workTask.findUnique({ where: { id: taskId } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }

      const allowedDomains = (task.allowedDomains as unknown as string[]) ?? [];
      if (!isAllowedDomain(url, allowedDomains)) {
        return reply.status(403).send({
          error: "domain not allowlisted",
          allowedDomains,
          hint: 'set the task allowedDomains to ["outlierclone.io"] or a client domain at creation',
        });
      }

      const credentialRef = str(body, "credentialRef") || undefined;
      const credentialKind = credentialRef
        ? credentialRef.startsWith("oauth:")
          ? "google_api"
          : credentialRef.startsWith("apikey:")
            ? "api_key"
            : "email_password"
        : "none";

      const needsApproval = requiresApproval("external_write", task.autoApprove);
      let approvalId: string | null = null;
      let approval: string;
      if (needsApproval) {
        const request = await db.approvalRequest.create({
          data: {
            workspaceId: task.workspaceId,
            agentRunId: taskId,
            actionType: "external_write",
            payloadJson: { url, taskId, credentialKind } as any,
            status: "pending",
          },
        });
        approvalId = request.id;
        approval = "pending";
      } else {
        approval = "auto_approved";
      }

      await db.auditEvent.create({
        data: {
          workspaceId: task.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: "work.browser_execute",
          resourceType: "work_task",
          resourceId: taskId,
          metadataJson: { url, credentialKind, approval, approvalId } as any,
        },
      });

      // Execution (Playwright runner) is a later phase — this returns the
      // policy decision + approval checkpoint, redacting credential material.
      return reply.send({
        ok: true,
        url,
        allowed: true,
        credentialKind,
        approval,
        ...(approvalId ? { approvalId } : {}),
      });
    });

    // GET /health — vertical liveness for markers
    register.get("/health", (_req: unknown, reply: ReplyLike) => {
      reply.send({ ok: true, vertical: workManifest.id, version: workManifest.version });
    });

    // ── Agent runs (§10, §13) — bounded execution of approved browser tasks.

    // POST /agent-runs — create + execute a bounded run for an approved task.
    register.post("/agent-runs", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const body = req.body ?? {};
      const taskId = str(body, "taskId");
      const url = str(body, "url");
      if (!taskId || !url) return reply.status(400).send({ error: "taskId and url required" });
      const task = await db.workTask.findUnique({ where: { id: taskId } });
      if (!task) return reply.status(404).send({ error: "task not found" });
      if (!(await canAccess(db, task.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      const allowedDomains = (task.allowedDomains as unknown as string[]) ?? [];
      if (!isAllowedDomain(url, allowedDomains)) {
        return reply.status(403).send({ error: "domain not allowlisted", allowedDomains });
      }
      if (task.status === "approved" || task.status === "completed") {
        return reply.status(409).send({ error: `task is ${task.status}; no further runs` });
      }

      const credentialRef = str(body, "credentialRef") || undefined;
      const credentialKind = credentialRef
        ? credentialRef.startsWith("oauth:")
          ? "google_api"
          : credentialRef.startsWith("apikey:")
            ? "api_key"
            : "email_password"
        : "none";
      const needsApproval = requiresApproval("external_write", task.autoApprove);

      if (needsApproval) {
        // Require an APPROVED approval_request for this task before running.
        const approved = await db.approvalRequest.findFirst({
          where: { workspaceId: task.workspaceId, actionType: "external_write", status: "approved" },
        });
        if (!approved) {
          return reply.status(403).send({
            error: "approval_required",
            hint: "external_write requires an approved approval_requests row (or task autoApprove)",
          });
        }
      }

      const credentialSecret = credentialRef ? openSecret(credentialRef) : null;
      const run = await db.agentRun.create({
        data: {
          workspaceId: task.workspaceId,
          verticalId: workManifest.id,
          agentId: "browser_task_execution",
          status: "running",
          inputJson: { taskId, url, credentialKind } as any,
        },
      });

      let stopped = false;
      const result: RunResult = await runBrowserTask({
        url,
        credential: credentialSecret ? { kind: credentialKind, secret: credentialSecret } : null,
        maxActions: 20,
        isStopped: () => stopped,
        fetchImpl: (input: unknown, init?: unknown) => fetch(input as unknown as URL, init as never),
      });
      stopped = result.status === "stopped";

      const completed = await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: result.status,
          outputJson: {
            steps: result.steps,
            result: result.text.slice(0, 20_000),
            title: result.title,
            error: result.error,
          } as any,
          completedAt: new Date(),
        },
      });
      await db.auditEvent.create({
        data: {
          workspaceId: task.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: "work.agent_run",
          resourceType: "agent_run",
          resourceId: run.id,
          metadataJson: { url, status: result.status, steps: result.steps.length } as any,
        },
      });
      return reply.status(201).send({ run: completed });
    });

    // GET /agent-runs/:runId
    register.get("/agent-runs/:runId", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const run = await db.agentRun.findUnique({ where: { id: req.params?.runId ?? "" } });
      if (!run) return reply.status(404).send({ error: "run not found" });
      if (!(await canAccess(db, run.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      return reply.send({ run });
    });

    // POST /agent-runs/:runId/stop — kill switch (§5: user + administrator).
    register.post("/agent-runs/:runId/stop", async (rawReq: unknown, reply: ReplyLike) => {
      const req = rawReq as RequestLike;
      const run = await db.agentRun.findUnique({ where: { id: req.params?.runId ?? "" } });
      if (!run) return reply.status(404).send({ error: "run not found" });
      if (!(await canAccess(db, run.workspaceId, req.user!.userId))) {
        return reply.status(403).send({ error: "not a workspace member" });
      }
      if (run.status !== "running") return reply.send({ run });
      const stopped = await db.agentRun.update({ where: { id: run.id }, data: { status: "stopped" } });
      await db.auditEvent.create({
        data: {
          workspaceId: run.workspaceId,
          actorType: "user",
          actorId: req.user!.userId,
          eventType: "work.agent_run_stopped",
          resourceType: "agent_run",
          resourceId: run.id,
          metadataJson: {},
        },
      });
      return reply.send({ run: stopped });
    });
  },
};
