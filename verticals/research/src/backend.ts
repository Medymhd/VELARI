/**
 * Research vertical backend — perplexity-style chat over the platform AI seam.
 * Answers route through the BYOK router (free local rungs included); when no
 * provider is eligible the route returns 503 so the UI can surface the BYOK
 * notice instead of inventing content.
 */
import type { VerticalRegistration, VerticalServices } from "@app/agent-sdk";
import { researchManifest } from "./manifest.js";

type Chat = { id: string; title: string; createdAt: string; workspaceId: string };
type Message = {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  providerId?: string;
  createdAt: string;
};

const chats = new Map<string, Chat>();
const messages = new Map<string, Message[]>();

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function bodyOf(req: unknown): Record<string, unknown> {
  return (req as { body?: Record<string, unknown> }).body ?? {};
}

function send(reply: unknown, payload: unknown): void {
  (reply as { send(v: unknown): unknown }).send(payload);
}

function status(reply: unknown, code: number) {
  return (reply as { status(n: number): { send(v: unknown): unknown } }).status(code);
}

export const vertical: VerticalRegistration = {
  manifest: researchManifest,
  registerRoutes(register, services) {
    const ai = services?.ai;

    register.post("/chats", (rawReq, reply) => {
      const body = bodyOf(rawReq);
      const workspaceId = (body.workspaceId as string) ?? "default";
      const firstQuestion = typeof body.question === "string" ? body.question : "";
      const title = ((typeof body.title === "string" && body.title) || firstQuestion || "New research").slice(0, 60);
      const chat: Chat = { id: newId(), title, createdAt: new Date().toISOString(), workspaceId };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      send(reply, { chat });
    });

    register.get("/chats", (rawReq, reply) => {
      const workspaceId = (rawReq as { query?: { workspaceId?: string } }).query?.workspaceId;
      const list = [...chats.values()]
        .filter((c) => !workspaceId || c.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      send(reply, { chats: list });
    });

    register.get("/chats/:id", (rawReq, reply) => {
      const chat = chats.get((rawReq as { params?: { id?: string } }).params?.id ?? "");
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      send(reply, { chat });
    });

    register.post("/chats/:id/messages", async (rawReq, reply) => {
      const chatId = (rawReq as { params?: { id?: string } }).params?.id ?? "";
      const chat = chats.get(chatId);
      if (!chat) return status(reply, 404).send({ error: "chat not found" });
      const body = bodyOf(rawReq);
      const question = (body.question as string) ?? "";
      if (!question.trim()) return status(reply, 400).send({ error: "question required" });

      const userMsg: Message = { id: newId(), chatId, role: "user", content: question, createdAt: new Date().toISOString() };
      const history = messages.get(chatId) ?? [];
      history.push(userMsg);

      if (!ai) {
        history.pop();
        return status(reply, 503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK) — the free local rung requires the API ai seam" });
      }

      try {
        const answer = await ai.ask({
          workspaceId: chat.workspaceId,
          taskClass: "deep_analysis",
          messages: [
            { role: "system", content: "You are a precise research assistant. Answer directly, cite concrete facts from the conversation, and note uncertainty honestly." },
            ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
          ],
        });
        const assistantMsg: Message = {
          id: newId(),
          chatId,
          role: "assistant",
          content: answer.text,
          providerId: answer.providerId,
          createdAt: new Date().toISOString(),
        };
        history.push(assistantMsg);
        messages.set(chatId, history);
        send(reply, { userMsg, assistantMsg });
      } catch (e) {
        history.pop();
        status(reply, 503).send({ error: "no_provider", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    register.get("/chats/:id/messages", (rawReq, reply) => {
      const chatId = (rawReq as { params?: { id?: string } }).params?.id ?? "";
      if (!chats.has(chatId)) return status(reply, 404).send({ error: "chat not found" });
      send(reply, { messages: messages.get(chatId) ?? [] });
    });

    register.get("/health", (_req, reply) => {
      send(reply, { ok: true, vertical: researchManifest.id, chats: chats.size });
    });
  },
};
