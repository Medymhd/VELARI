/**
 * Interview Intelligence vertical — manifest (architecture doc §10).
 * Declares capabilities, permissions, routes, tools and retention defaults.
 * The platform validates this at install/boot time; the vertical never
 * touches another vertical's tables, prompts or integrations (§3 module rule).
 */
import type { VerticalManifest } from "@app/contracts";

export const interviewIntelligenceManifest: VerticalManifest = {
  id: "interview-intelligence",
  version: "0.1.0",
  displayName: "Interview Intelligence",
  requiredCapabilities: ["chat", "structured_output", "streaming", "speech_to_text"],
  requiredPermissions: ["microphone"],
  routes: [
    { method: "GET", path: "/question-bank", handlerId: "questionBank.list" },
    { method: "POST", path: "/rehearsal/framework", handlerId: "rehearsal.framework" },
    { method: "POST", path: "/interviewer/sheet", handlerId: "interviewer.sheet" },
    { method: "POST", path: "/interviewer/probe", handlerId: "interviewer.probe" },
    { method: "POST", path: "/session/suggest-title", handlerId: "session.suggestTitle" },
  ],
  tools: [
    {
      id: "interview.generate_followup_email",
      description: "Draft a post-interview follow-up email for user approval.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          tone: { type: "string", enum: ["concise", "warm", "formal"] },
        },
        required: ["sessionId"],
      },
      risk: "external_write",
    },
  ],
  retentionDefaults: "retain_30d",
  overlay: { mode: "stealth", size: [440, 430] },
};

