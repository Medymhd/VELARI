/**
 * Work vertical — manifest (valeriworkvertical.md §4, §15).
 * Commercial make-then-break: real tasks on client-authorized domains,
 * vaulted credentials (Google OAuth / email+password / API key), and
 * approval + auto-approve for external_write.
 */
import type { VerticalManifest } from "@app/contracts";

export const workManifest: VerticalManifest = {
  id: "work",
  version: "0.1.0",
  displayName: "Velari Work",
  requiredCapabilities: ["chat", "structured_output", "streaming", "vision", "embeddings"],
  requiredPermissions: ["screen_capture", "credential_storage"],
  routes: [
    { method: "POST", path: "/tasks", handlerId: "tasks.create" },
    { method: "GET", path: "/tasks", handlerId: "tasks.list" },
    { method: "GET", path: "/tasks/:id", handlerId: "tasks.get" },
    { method: "POST", path: "/tasks/:id/assign", handlerId: "tasks.assign" },
    { method: "POST", path: "/tasks/:id/submit", handlerId: "tasks.submit" },
    { method: "POST", path: "/tasks/:id/review", handlerId: "tasks.review" },
    { method: "POST", path: "/rubrics", handlerId: "rubrics.create" },
    { method: "GET", path: "/rubrics/:id", handlerId: "rubrics.get" },
    { method: "POST", path: "/code/explain", handlerId: "code.explain" },
    { method: "POST", path: "/code/review", handlerId: "code.review" },
    { method: "POST", path: "/agent-runs", handlerId: "agent-runs.create" },
    { method: "GET", path: "/agent-runs/:runId", handlerId: "agent-runs.get" },
    { method: "POST", path: "/agent-runs/:runId/approve", handlerId: "agent-runs.approve" },
    { method: "POST", path: "/agent-runs/:runId/stop", handlerId: "agent-runs.stop" },
    { method: "POST", path: "/annotations", handlerId: "annotations.create" },
    { method: "GET", path: "/annotations", handlerId: "annotations.list" },
    { method: "POST", path: "/annotations/:id/review", handlerId: "annotations.review" },
    { method: "GET", path: "/tasks/:taskId/annotation-agreement", handlerId: "annotations.agreement" },
    { method: "POST", path: "/simulation/run", handlerId: "simulation.run" },
    { method: "GET", path: "/detection-cases", handlerId: "detection-cases.list" },
  ],
  tools: [
    {
      id: "work.browser_task_execution",
      description: "Execute a bounded browser task on an allowlisted domain (default [] blank for now; canonical outlierclone.io + client-authorized when populated). Requires vaulted credential (Google OAuth, email/password, or API key) and policyVersion approval.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          taskId: { type: "string" },
          credentialRef: { type: "string", description: "vault secret_ref for Google OAuth / email+password / API key" },
          autoApprove: { type: "boolean", description: "when true, external_write auto-approves if workspace policy allows" },
        },
        required: ["url", "taskId"],
      },
      risk: "external_write",
    },
    {
      id: "work.assess_with_rubric",
      description: "Generate rubric-aligned draft assessment with evidence citations.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          rubricId: { type: "string" },
        },
        required: ["taskId", "rubricId"],
      },
      risk: "read",
    },
    {
      id: "work.code_suggest_fix",
      description: "Coding work: propose a concrete fix for reviewed code (merged from the coding-assistant vertical).",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          language: { type: "string" },
          code: { type: "string" },
        },
        required: ["taskId", "code"],
      },
      risk: "external_write",
    },
  ],
  retentionDefaults: "retain_30d",
};
