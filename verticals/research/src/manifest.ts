/**
 * Research vertical — perplexity-type chat (valeriworkvertical.md §5 Guide mode, Knowledge Worker).
 * Perplexity-style: new chat, follow-up questions, history tomorrow, pgvector recall.
 * Brand-neutral: id "research" (not "velari-research"), overlay none — immersive desktop to interact.
 */
import type { VerticalManifest } from "@app/contracts";

export const researchManifest: VerticalManifest = {
  id: "research",
  version: "0.1.0",
  displayName: "Research",
  requiredCapabilities: ["chat", "structured_output", "streaming", "embeddings", "vision"],
  requiredPermissions: [],
  routes: [
    { method: "POST", path: "/chats", handlerId: "chats.create" },
    { method: "GET", path: "/chats", handlerId: "chats.list" },
    { method: "GET", path: "/chats/:id", handlerId: "chats.get" },
    { method: "POST", path: "/chats/:id/messages", handlerId: "chats.message" },
    { method: "GET", path: "/chats/:id/messages", handlerId: "chats.messages" },
  ],
  tools: [
    {
      id: "research.answer_with_citations",
      description: "Answer research question with citations from pgvector recall.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          question: { type: "string" },
        },
        required: ["chatId", "question"],
      },
      risk: "read",
    },
  ],
  retentionDefaults: "retain_30d",
  overlay: { mode: "none" },
};
