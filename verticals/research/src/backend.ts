/**
 * Copilot (research vertical) backend â€” durable perplexity-style chat over the
 * platform AI seam. Threads and messages persist in Postgres via the platform
 * db seam (survives API restarts â€” the in-memory Map lost every thread on
 * redeploy). Answers route through the BYOK router (free local rungs
 * included); when no provider is eligible the route returns 503 so the UI can
 * surface the BYOK notice instead of inventing content.
 */
import type { VerticalRegistration, VerticalServices, RouteRegistrar, ReplyLike } from "@app/agent-sdk";
import { researchManifest } from "./manifest.js";

/** Typed facade over the Prisma client â€” no Prisma import in the vertical. */
interface PersonaDb {
  researchChat: {
    create(args: { data: { id: string; workspaceId: string; title: string } }): Promise<{ id: string; workspaceId: string; title: string; createdAt: Date }>;
    findMany(args: {
      where?: { workspaceId: string };
      orderBy: { createdAt: "desc" };
      take?: number;
    }): Promise<{ id: string; title: string; createdAt: Date }[]>;
    findFirst(args: { where: { id: string; workspaceId?: string } }): Promise<{ id: string; workspaceId: string; title: string } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  researchMessage: {
    createMany(args: { data: { chatId: string; role: string; content: string; providerId?: string | null }[] }): Promise<unknown>;
    findMany(args: { where: { chatId: string }, orderBy: { createdAt: "asc" } }): Promise<{ id: string; chatId: string; role: string; content: string; providerId: string | null; createdAt: Date }[]>;
    deleteMany(args: { where: { chatId: string } }): Promise<unknown>;
  };
}

function bodyOf(req: unknown): Record<string, unknown> {
  return (req as { body?: Record<string, unknown> }).body ?? {};
}

function send(reply: ReplyLike, payload: unknown): void {
  reply.send(payload);
}

function status(reply: ReplyLike, code: number) {
  return reply.status(code);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Tenant scoping: chats resolve workspace-bound whenever the caller supplies
 *  its workspaceId (query for GET/DELETE, body for POST). Chat ids are
 *  unguessable UUIDs; the extra bound keeps one workspace out of another's
 *  threads even on a leaked id. */
function scopeOf(rawReq: unknown, body?: Record<string, unknown>): { id: string; workspaceId?: string } {
  const params = (rawReq as { params?: { id?: string } }).params ?? {};
  const query = (rawReq as { query?: { workspaceId?: string } }).query ?? {};
  const workspaceId = str(query.workspaceId) || str(body?.workspaceId) || undefined;
  return { id: params.id ?? "", workspaceId };
}

export const vertical: VerticalRegistration = {
  manifest: researchManifest,
  registerRoutes(register: RouteRegistrar, services: VerticalServices) {
    const ai = services?.ai;
    const db = services?.db as PersonaDb | undefined;

    register.post("/chats", async (rawReq, reply) => {
      const body = bodyOf(rawReq);
      const workspaceId = str(body.workspaceId) || "default";
      const firstQuestion = str(body.question);
      const title = ((str(body.title) || firstQuestion || "New thread").slice(0, 60)).trim();
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const chat = await db.researchChat.create({ data: { id: crypto.randomUUID(), workspaceId, title: title || "New thread" } });
      send(reply, { chat: { id: chat.id, title: chat.title, createdAt: chat.createdAt.toISOString() } });
    });

    register.get("/chats", async (rawReq, reply) => {
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const workspaceId = (rawReq as { query?: { workspaceId?: string } }).query?.workspaceId;
      const rows = await db.researchChat.findMany({
        where: workspaceId ? { workspaceId } : undefined,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      send(reply, { chats: rows.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt.toISOString() })) });
    });

    register.get("/chats/:id", async (rawReq, reply) => {
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const sc = scopeOf(rawReq);
      const chat = await db.researchChat.findFirst({ where: sc.workspaceId ? { id: sc.id, workspaceId: sc.workspaceId } : { id: sc.id } });
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      send(reply, { chat: { id: chat.id, title: chat.title, createdAt: (chat as { createdAt?: Date }).createdAt?.toISOString?.() ?? new Date().toISOString() } });
    });

    register.post("/chats/:id/messages", async (rawReq, reply) => {
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const body = bodyOf(rawReq);
      const sc = scopeOf(rawReq, body);
      const chatId = sc.id;
      const chat = await db.researchChat.findFirst({ where: sc.workspaceId ? { id: chatId, workspaceId: sc.workspaceId } : { id: chatId } });
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      const question = str(body.question);
      if (!question.trim()) return status(reply, 400).send({ error: "question required" });

      if (!ai) {
        return status(reply, 503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK) â€” the free local rung requires the API ai seam" });
      }

      // History BEFORE this turn (last 10) â€” this turn's messages persist after
      // the answer succeeds, so a failed call never leaves a dangling user row.
      const prior = await db.researchMessage.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } });
      const history = prior.slice(-10).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      try {
        const answer = await ai.ask({
          workspaceId: chat.workspaceId,
          taskClass: "deep_analysis",
          messages: [
            { role: "system", content: "You are a precise research assistant. Answer directly, cite concrete facts from the conversation, and note uncertainty honestly." },
            ...history,
            { role: "user", content: question },
          ],
        });
        const now = new Date();
        await db.researchMessage.createMany({
          data: [
            { chatId, role: "user", content: question },
            { chatId, role: "assistant", content: answer.text, providerId: answer.providerId ?? null },
          ],
        });
        send(reply, {
          userMsg: { id: `u-${now.getTime()}`, chatId, role: "user", content: question, createdAt: now.toISOString() },
          assistantMsg: { id: `a-${now.getTime()}`, chatId, role: "assistant", content: answer.text, providerId: answer.providerId, createdAt: now.toISOString() },
        });
      } catch (e) {
        status(reply, 503).send({ error: "no_provider", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    register.get("/chats/:id/messages", async (rawReq, reply) => {
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const sc = scopeOf(rawReq);
      const chatId = sc.id;
      const chat = await db.researchChat.findFirst({ where: sc.workspaceId ? { id: chatId, workspaceId: sc.workspaceId } : { id: chatId } });
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      const rows = await db.researchMessage.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } });
      send(reply, {
        messages: rows.map((m) => ({
          id: m.id, chatId: m.chatId, role: m.role, content: m.content,
          providerId: m.providerId ?? undefined, createdAt: m.createdAt.toISOString(),
        })),
      });
    });

    register.delete("/chats/:id", async (rawReq, reply) => {
      if (!db) return status(reply, 503).send({ error: "db_unavailable" });
      const sc = scopeOf(rawReq);
      const chat = await db.researchChat.findFirst({ where: sc.workspaceId ? { id: sc.id, workspaceId: sc.workspaceId } : { id: sc.id } });
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      await db.researchMessage.deleteMany({ where: { chatId: sc.id } });
      await db.researchChat.delete({ where: { id: sc.id } });
      send(reply, { ok: true });
    });

    register.get("/health", async (_req, reply) => {
      let chats = 0;
      try {
        chats = db ? (await db.researchChat.findMany({ orderBy: { createdAt: "desc" }, take: 100 })).length : 0;
      } catch { /* db down â€” health still reports */ }
      send(reply, { ok: true, vertical: researchManifest.id, chats, durable: Boolean(db) });
    });
  },
};
