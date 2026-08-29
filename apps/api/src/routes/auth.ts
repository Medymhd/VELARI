import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { issueToken, verifyToken, type AuthUser } from "../auth.js";
import { writeAudit } from "../audit.js";
import { toJson } from "../db.js";

/** Dev-friendly session bootstrap: upsert user by email, ensure a workspace. */
export function authRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/auth/session", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; displayName?: string; workspaceName?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.status(400).send({ error: "valid email required" });
    }

    const user = await db.user.upsert({
      where: { email },
      update: { displayName: body.displayName ?? undefined },
      create: { email, displayName: body.displayName ?? null },
    });

    let membership = await db.workspaceMember.findFirst({ where: { userId: user.id } });
    if (!membership) {
      const ws = await db.workspace.create({
        data: {
          name: body.workspaceName ?? `${user.email.split("@")[0]}'s workspace`,
          policyJson: { privacyMode: "managed_allowed", disableCloudStt: false },
        },
      });
      membership = await db.workspaceMember.create({
        data: { workspaceId: ws.id, userId: user.id, role: "owner" },
      });
    }

    await writeAudit(db, {
      workspaceId: membership.workspaceId,
      actorType: "user",
      actorId: user.id,
      eventType: "auth.session_issued",
      resourceType: "user",
      resourceId: user.id,
    });

    return reply.send({
      token: issueToken(user.id),
      user: toJson(user),
      workspaceId: membership.workspaceId,
    });
  });

  app.get("/v1/auth/verify", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    const user = token ? verifyToken(token) : null;
    if (!user) return reply.status(401).send({ valid: false });
    return reply.send({ valid: true, userId: (user as AuthUser).userId });
  });
}
