import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { toJson } from "../db.js";
import { writeAudit } from "../audit.js";

export function workspaceRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.get("/v1/workspaces", async (req) => {
    const userId = req.user!.userId;
    const memberships = await db.workspaceMember.findMany({ where: { userId } });
    const ids = memberships.map((m) => m.workspaceId);
    const workspaces = await db.workspace.findMany({ where: { id: { in: ids } } });
    return toJson(
      workspaces.map((w) => ({
        ...w,
        role: memberships.find((m) => m.workspaceId === w.id)?.role ?? "member",
      })),
    );
  });

  app.post("/v1/workspaces", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name?.trim()) return reply.status(400).send({ error: "name required" });

    const ws = await db.workspace.create({ data: { name: body.name.trim() } });
    await db.workspaceMember.create({
      data: { workspaceId: ws.id, userId, role: "owner" },
    });
    await writeAudit(db, {
      workspaceId: ws.id,
      actorType: "user",
      actorId: userId,
      eventType: "workspace.created",
      resourceType: "workspace",
      resourceId: ws.id,
    });
    return reply.status(201).send(toJson(ws));
  });

  app.get("/v1/workspaces/:id/policy", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await assertMembership(db, req.user!.userId, id))) {
      return reply.status(403).send({ error: "not a member of this workspace" });
    }
    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) return reply.status(404).send({ error: "workspace not found" });
    return reply.send(toJson(ws.policyJson));
  });

  app.patch("/v1/workspaces/:id/policy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.userId;
    if (!(await assertRole(db, userId, id, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const ws = await db.workspace.findUnique({ where: { id } });
    if (!ws) return reply.status(404).send({ error: "workspace not found" });

    const nextPolicy = { ...(ws.policyJson as Record<string, unknown>), ...patch };
    const updated = await db.workspace.update({ where: { id }, data: { policyJson: nextPolicy as any as any } });
    await writeAudit(db, {
      workspaceId: id,
      actorType: "user",
      actorId: userId,
      eventType: "workspace.policy_updated",
      resourceType: "workspace",
      resourceId: id,
      metadataJson: { keys: Object.keys(patch) },
    });
    return reply.send(toJson(updated.policyJson));
  });
}

export async function assertMembership(db: PrismaClient, userId: string, workspaceId: string): Promise<boolean> {
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return Boolean(m);
}

export async function assertRole(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  roles: string[],
): Promise<boolean> {
  const m = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return Boolean(m && roles.includes(m.role));
}
