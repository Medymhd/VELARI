import type { VerticalRegistration } from "@app/agent-sdk";
import { codingAssistantManifest } from "./manifest.js";
import { buildCodeExplainMessages, buildCodeReviewMessages } from "./prompts.js";

export const vertical: VerticalRegistration = {
  manifest: codingAssistantManifest,
  registerRoutes(register) {
    register.post("/explain", (req, reply) => {
      const body = (req as { body?: { code?: string; language?: string } }).body ?? {};
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) return reply.status(400).send({ error: "code required" });
      const messages = buildCodeExplainMessages(code, body.language);
      reply.send({ messages, hint: "forward to ai-runtime router with vision if screenshot present" });
    });
    register.post("/review", (req, reply) => {
      const body = (req as { body?: { code?: string } }).body ?? {};
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) return reply.status(400).send({ error: "code required" });
      reply.send({ messages: buildCodeReviewMessages(code) });
    });
  },
};

export { codingAssistantManifest };
