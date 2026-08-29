import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CircuitBreakerRegistry } from "@app/ai-runtime";
import { secretBox } from "../secrets.js";
import { writeAudit } from "../audit.js";
import { toJson } from "../db.js";
import { assertRole } from "./workspaces.js";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";

const breakers = new CircuitBreakerRegistry();

export function providerRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/provider-connections", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      provider?: string;
      authMode?: string;
      secret?: string;
      capabilities?: string[];
    };
    if (!body.workspaceId || !body.provider || !body.secret) {
      return reply.status(400).send({ error: "workspaceId, provider and secret are required" });
    }
    if (!(await assertRole(db, userId, body.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }

    const sealed = secretBox.seal(body.secret);
    const conn = await db.providerConnection.create({
      data: {
        workspaceId: body.workspaceId,
        provider: body.provider,
        authMode: body.authMode ?? "byok",
        secretRef: sealed.sealed,
        status: "active",
        capabilities: (body.capabilities ?? []) as any,
        metadataJson: {} as any,
      },
    });
    await writeAudit(db, {
      workspaceId: body.workspaceId,
      actorType: "user",
      actorId: userId,
      eventType: "provider.connected",
      resourceType: "provider_connection",
      resourceId: conn.id,
      metadataJson: { provider: body.provider },
    });

    // Never echo the secret or its material.
    return reply.status(201).send(toJson({ ...conn, secretRef: undefined, hasSecret: true }));
  });

  app.get("/v1/provider-connections", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return [];
    const rows = await db.providerConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return toJson(rows.map((r) => ({ ...r, secretRef: undefined, hasSecret: Boolean(r.secretRef) })));
  });

  app.delete("/v1/provider-connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await db.providerConnection.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: "not found" });
    if (!(await assertRole(db, req.user!.userId, existing.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    await db.providerConnection.delete({ where: { id } });
    await writeAudit(db, {
      workspaceId: existing.workspaceId,
      actorType: "user",
      actorId: req.user!.userId,
      eventType: "provider.disconnected",
      resourceType: "provider_connection",
      resourceId: id,
    });
    return reply.send({ deleted: true });
  });

  app.get("/v1/model-profiles", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return [];
    const rows = await db.modelProfile.findMany({ where: { workspaceId } });
    return toJson(rows);
  });

  app.put("/v1/model-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      name?: string;
      taskClass?: string;
      primaryModel?: Record<string, unknown>;
      fallbackModels?: Record<string, unknown>[];
      constraintsJson?: Record<string, unknown>;
      enabled?: boolean;
    };
    if (!body.workspaceId) return reply.status(400).send({ error: "workspaceId required" });
    if (!(await assertRole(db, req.user!.userId, body.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    const saved = await db.modelProfile.upsert({
      where: { id },
      update: {
        name: body.name,
        taskClass: body.taskClass,
        primaryModel: (body.primaryModel ?? {}) as any,
        fallbackModels: (body.fallbackModels ?? []) as any,
        constraintsJson: (body.constraintsJson ?? {}) as any,
        enabled: body.enabled ?? true,
      },
      create: {
        id,
        workspaceId: body.workspaceId,
        name: body.name ?? "default",
        taskClass: body.taskClass ?? "live_coach",
        primaryModel: (body.primaryModel ?? {}) as any,
        fallbackModels: (body.fallbackModels ?? []) as any,
        constraintsJson: (body.constraintsJson ?? {}) as any,
        enabled: body.enabled ?? true,
      },
    });
    return reply.send(toJson(saved));
  });

  /** Probe a profile through the real router Ã¢â‚¬â€ proves failover wiring works. */
  app.post("/v1/model-profiles/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await db.modelProfile.findUnique({ where: { id } });
    if (!profile) return reply.status(404).send({ error: "not found" });

    const cfg = await loadWorkspaceAiConfig(db, profile.workspaceId);
    const started = Date.now();
    const outcome = await executeRouted(
      { db, breakers },
      cfg,
      profile.workspaceId,
      null,
      {
        taskClass: "live_coach",
        privacyMode: cfg.privacyMode,
        messages: [
          { role: "system", content: 'Reply with JSON {"ok":true}' },
          { role: "user", content: "Connectivity probe. Respond with the JSON." },
        ],
      },
    );
    return reply.send({
      ok: outcome.ok,
      latencyMs: Date.now() - started,
      providerId: outcome.ok ? undefined : outcome.error,
      textPreview: typeof outcome.text === "string" ? outcome.text.slice(0, 120) : undefined,
    });
  });
}

