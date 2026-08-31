/**
 * Vision endpoint — screenshot(s) + prompt through the provider-neutral
 * router with the same failover/usage path as text coaching (rival
 * `VisionProviderFallbackChain` parity, routed server-side).
 */
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CircuitBreakerRegistry, buildVisionMessages, imageHash, optimizeImage, ocrWithFallback } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";
import { logger } from "@app/observability";

const log = logger({ svc: "vision" });
const breakers = new CircuitBreakerRegistry();

interface VisionBody {
  sessionId?: string;
  prompt?: string;
  images?: { base64?: string; mimeType?: string }[];
}

export function visionRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/ai/vision", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as VisionBody;
    const prompt = (body.prompt ?? "").trim();
    const rawImages = (body.images ?? []).filter((i): i is { base64: string; mimeType?: string } => Boolean(i.base64));
    if (!prompt || rawImages.length === 0) {
      return reply.status(400).send({ error: "prompt and at least one image are required" });
    }

    // Optimize before routing (rival ImageOptimizer parity): EXIF-rotate,
    // fit inside 1024px, jpeg q70 — cuts vision payload ~10x and upload time.
    // Identical consecutive shots (FNV-1a) collapse to one.
    const images: { base64: string; mimeType: string }[] = [];
    const seen = new Set<string>();
    for (const img of rawImages) {
      const hash = imageHash(img.base64);
      if (seen.has(hash)) continue;
      seen.add(hash);
      try {
        images.push({ base64: await optimizeImage(img.base64), mimeType: "image/jpeg" });
      } catch {
        images.push({ base64: img.base64, mimeType: img.mimeType ?? "image/png" });
      }
      if (images.length >= 3) break;
    }

    let workspaceId: string;
    let sessionId: string | null = null;
    if (body.sessionId) {
      const session = await db.interviewSession.findUnique({ where: { id: body.sessionId } });
      if (!session) return reply.status(404).send({ error: "session not found" });
      if (session.ownerUserId !== userId) {
        const member = await db.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: session.workspaceId, userId } },
        });
        if (!member) return reply.status(403).send({ error: "not a workspace member" });
      }
      workspaceId = session.workspaceId;
      sessionId = session.id;
    } else {
      const membership = await db.workspaceMember.findFirst({ where: { userId } });
      if (!membership) return reply.status(403).send({ error: "no workspace membership" });
      workspaceId = membership.workspaceId;
    }

    try {
      const cfg = await loadWorkspaceAiConfig(db, workspaceId);
      const outcome = await executeRouted({ db, breakers }, cfg, workspaceId, sessionId, {
        taskClass: "vision",
        privacyMode: cfg.privacyMode,
        maxLatencyMs: 20_000,
        messages: buildVisionMessages({
          prompt,
          privacyMode: cfg.privacyMode,
          images: images.map((i) => ({ base64: i.base64, mimeType: i.mimeType ?? "image/png" })),
        }),
      });
      if (!outcome.ok) {
        // Vision denied/failed → local OCR fallback (private_vision mode).
        const ocr = await ocrWithFallback(images[0]!.base64, true);
        if (ocr?.text) {
          return { ok: true, mode: "ocr", text: ocr.text, confidence: ocr.confidence };
        }
        return reply.status(502).send({ error: "vision_unavailable" });
      }
      return { ok: true, mode: "vision", text: outcome.text ?? "" };
    } catch (e) {
      log.warn("vision request failed", { error: String(e) });
      return reply.status(500).send({ error: "vision failed" });
    }
  });
}
