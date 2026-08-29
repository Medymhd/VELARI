/**
 * Vertical backend module. Registered by the platform API at boot under
 * `/v1/verticals/interview-intelligence`. Receives a RouteRegistrar so the
 * vertical stays decoupled from the concrete server framework (agent-sdk).
 */
import type { VerticalRegistration } from "@app/agent-sdk";
import { interviewIntelligenceManifest } from "./manifest.js";
import { QUESTION_BANK, offlineFramework } from "./prompts.js";

export const vertical: VerticalRegistration = {
  manifest: interviewIntelligenceManifest,
  registerRoutes(register) {
    register.get("/question-bank", (_req, reply) => {
      reply.send({ items: QUESTION_BANK });
    });
    register.post("/rehearsal/framework", (req, reply) => {
      const body = (req as { body?: { transcript?: string } }).body ?? {};
      const transcript = typeof body.transcript === "string" ? body.transcript : "";
      // Framework-only rehearsal: deterministic, no provider call, no cost.
      reply.send({ mode: "framework_only", framework: offlineFramework(transcript) });
    });
  },
};

export { interviewIntelligenceManifest };

