import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit.js";
import { toJson } from "../db.js";

export function browserRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/browser/capture", async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; site?: string | null; text?: string };
    if (!body.text) return reply.status(400).send({ error: "text required" });
    // For demo: store as artifact linked to a workspace if provided via header, else ephemeral
    const workspaceId = (req.headers["x-workspace-id"] as string | undefined) ?? null;
    const artifact = workspaceId
      ? await db.artifact.create({
          data: {
            workspaceId,
            kind: "browser_capture",
            storageKey: `browser/${Date.now()}.json`,
            contentType: "application/json",
            sizeBytes: BigInt(Buffer.byteLength(body.text)),
          },
        })
      : null;
    if (artifact && workspaceId) {
      await writeAudit(db, {
        workspaceId,
        actorType: "user",
        actorId: (req.user as { userId?: string } | undefined)?.userId ?? null,
        eventType: "browser.captured",
        resourceType: "artifact",
        resourceId: artifact.id,
        metadataJson: { site: body.site, url: body.url } as any,
      });
    }
    return reply.send(toJson({ ok: true, artifactId: artifact?.id ?? null, site: body.site }));
  });
}
