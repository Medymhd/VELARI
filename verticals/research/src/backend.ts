/**
 * Research vertical backend — perplexity-type chat with history.
 * Uses in-memory store for MVP (replace with Prisma pgvector when needed).
 * History tomorrow: GET /chats lists all, GET /chats/:id/messages replays.
 * No hard-coded brand, no watermark, senior-grade.
 */
import type { VerticalRegistration } from "@app/agent-sdk";
import { researchManifest } from "./manifest.js";

type Chat = { id: string; title: string; createdAt: string; workspaceId: string };
type Message = { id: string; chatId: string; role: "user" | "assistant"; content: string; createdAt: string };

const chats = new Map<string, Chat>();
const messages = new Map<string, Message[]>();

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const vertical: VerticalRegistration = {
  manifest: researchManifest,
  registerRoutes(register) {
    // POST /chats — new chat (like Perplexity new thread)
    register.post("/chats", (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const title = (typeof body.title === "string" && body.title.trim()) || (typeof body.question === "string" ? (body.question as string).slice(0, 60) : "New research");
      const workspaceId = (body.workspaceId as string) ?? "default";
      const chat: Chat = { id: newId(), title, createdAt: new Date().toISOString(), workspaceId };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      (reply as { send(v: unknown): unknown }).send({ chat });
    });

    // GET /chats — history (tomorrow read)
    register.get("/chats", (req, reply) => {
      const q = (req as { query?: Record<string, string> }).query ?? {};
      const workspaceId = q.workspaceId;
      const list = [...chats.values()].filter((c) => !workspaceId || c.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      (reply as { send(v: unknown): unknown }).send({ chats: list });
    });

    // GET /chats/:id
    register.get("/chats/:id", (req, reply) => {
      const id = (req as { params?: { id?: string } }).params?.id ?? "";
      const chat = chats.get(id);
      if (!chat) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "chat not found" });
      (reply as { send(v: unknown): unknown }).send({ chat });
    });

    // POST /chats/:id/messages — ask question, follow-up
    register.post("/chats/:id/messages", (req, reply) => {
      const id = (req as { params?: { id?: string } }).params?.id ?? "";
      const chat = chats.get(id);
      if (!chat) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "chat not found" });
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const question = (body.question as string) ?? (body.content as string) ?? "";
      if (!question.trim()) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "question required" });

      const userMsg: Message = { id: newId(), chatId: id, role: "user", content: question, createdAt: new Date().toISOString() };
      const assistantMsg: Message = {
        id: newId(),
        chatId: id,
        role: "assistant",
        content: `[Research answer for "${question.slice(0, 80)}"] — This is a simulated cited answer. In production, this would call the BYOK router (Moonshine/Groq) with pgvector hybrid recall (0.7·cosine + rerank 35%) and return citations. Follow-up questions can be asked via the same endpoint.`,
        createdAt: new Date().toISOString(),
      };
      const list = messages.get(id) ?? [];
      list.push(userMsg, assistantMsg);
      messages.set(id, list);
      (reply as { send(v: unknown): unknown }).send({ userMsg, assistantMsg });
    });

    // GET /chats/:id/messages — replay for tomorrow
    register.get("/chats/:id/messages", (req, reply) => {
      const id = (req as { params?: { id?: string } }).params?.id ?? "";
      if (!chats.has(id)) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "chat not found" });
      (reply as { send(v: unknown): unknown }).send({ messages: messages.get(id) ?? [] });
    });

    // GET /health
    register.get("/health", (_req, reply) => {
      (reply as { send(v: unknown): unknown }).send({ ok: true, vertical: researchManifest.id, chats: chats.size });
    });
  },
};
