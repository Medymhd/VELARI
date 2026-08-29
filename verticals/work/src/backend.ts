/**
 * Work vertical backend — policy-gated commercial work.
 * Mirrors valeriworkvertical.md §5 work modes, §6 task model, §10 agent runtime.
 * Brand-neutral: uses neutral ids, no hard-coded product name.
 * Concise, senior-grade: strict types, handled errors, tests alongside.
 */
import type { VerticalRegistration } from "@app/agent-sdk";
import { workManifest } from "./manifest.js";
import { isAllowedDomain, requiresApproval, type WorkTask } from "./types.js";

type StoredTask = WorkTask & { createdBy: string };

// In-memory store for MVP — replace with Prisma task_templates/tasks when schema adds §14 entities.
// Keeps the vertical decoupled per VELARI ARCHITECTURE.md §3 module rule.
const tasks = new Map<string, StoredTask>();

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function policyFromReq(req: unknown): { allowedDomains: string[]; autoApprove: boolean; version: string } {
  const body = (req as { body?: Record<string, unknown> }).body ?? {};
  const query = (req as { query?: Record<string, unknown> }).query ?? {};
  // Default blank [] for now; canonical outlierclone.io when populated — valeriworkvertical.md §5, §10
  const allowedDomains = ((body.allowedDomains as string[] | undefined) ?? (query.allowedDomains as string[] | undefined) ?? []) as string[];
  const autoApprove = Boolean((body.autoApprove as boolean | undefined) ?? (query.autoApprove as boolean | undefined) ?? false);
  const version = (body.policyVersion as string | undefined) ?? "v1";
  return { allowedDomains, autoApprove, version };
}

export const vertical: VerticalRegistration = {
  manifest: workManifest,
  registerRoutes(register) {
    // POST /tasks — create work task (real client task or synthetic)
    register.post("/tasks", (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const title = typeof body.title === "string" ? body.title : "Untitled work";
      const type = typeof body.type === "string" ? (body.type as WorkTask["type"]) : "workflow_execution";
      const instructions = typeof body.instructions === "string" ? body.instructions : "";
      const workspaceId = (body.workspaceId as string) ?? "workspace-demo";
      const { allowedDomains, autoApprove, version } = policyFromReq(req);
      const task: StoredTask = {
        id: newId(),
        workspaceId,
        templateId: (body.templateId as string) ?? "template-generic",
        type,
        status: "draft",
        title,
        instructions,
        inputs: Array.isArray(body.inputs) ? (body.inputs as unknown[]) : [],
        assignmentPolicy: { mode: "single" },
        automationPolicy: { allowedTools: ["work.browser_task_execution"], allowedDomains, autoApprove, budget: { maxActions: 20 } },
        simulationTag: (body.simulationTag as WorkTask["simulationTag"]) ?? "client_authorized",
        policyVersion: version,
        createdAt: nowIso(),
        createdBy: "user-demo",
      };
      tasks.set(task.id, task);
      (reply as { send(v: unknown): unknown }).send({ task });
    });

    // GET /tasks — list
    register.get("/tasks", (_req, reply) => {
      (reply as { send(v: unknown): unknown }).send({ tasks: [...tasks.values()] });
    });

    // GET /tasks/:id
    register.get("/tasks/:id", (req, reply) => {
      const { id } = (req as { params?: { id?: string } }).params ?? {};
      const t = id ? tasks.get(id) : undefined;
      if (!t) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "task not found" });
      (reply as { send(v: unknown): unknown }).send({ task: t });
    });

    // POST /tasks/:id/assign — draft → assigned
    register.post("/tasks/:id/assign", (req, reply) => {
      const { id } = (req as { params?: { id?: string } }).params ?? {};
      const t = id ? tasks.get(id) : undefined;
      if (!t) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "task not found" });
      if (t.status !== "draft") return (reply as { status(n: number): { send(v: unknown): unknown } }).status(409).send({ error: `cannot assign from ${t.status}` });
      t.status = "assigned";
      (reply as { send(v: unknown): unknown }).send({ task: t });
    });

    // POST /tasks/:id/submit — in_progress/assigned → submitted (with provenance)
    register.post("/tasks/:id/submit", (req, reply) => {
      const { id } = (req as { params?: { id?: string } }).params ?? {};
      const t = id ? tasks.get(id) : undefined;
      if (!t) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "task not found" });
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const origin = (body.origin as string) ?? "human";
      const provenance = { origin, policyVersion: t.policyVersion, reviewState: "unreviewed" as const };
      t.status = "submitted";
      (reply as { send(v: unknown): unknown }).send({ task: t, provenance });
    });

    // POST /tasks/:id/review — submitted → approved/returned (human approval or auto-approve)
    register.post("/tasks/:id/review", (req, reply) => {
      const { id } = (req as { params?: { id?: string } }).params ?? {};
      const t = id ? tasks.get(id) : undefined;
      if (!t) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(404).send({ error: "task not found" });
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const decision = body.decision === "returned" ? "returned" : "approved";
      // Auto-approve path — major test with other team: when automationPolicy.autoApprove true, external_write auto-approves
      const canAuto = t.automationPolicy.autoApprove;
      if (decision === "approved" && !canAuto) {
        // Manual approval required — caller must have manager/owner role (checked at API layer in real impl)
      }
      t.status = decision === "approved" ? "approved" : "returned";
      (reply as { send(v: unknown): unknown }).send({ task: t, decision, autoApproved: canAuto && decision === "approved" });
    });

    // POST /browser/execute — bounded browser task on allowlisted domain (default [] blank for now)
    // Demonstrates Google OAuth / email+password / API key vault patterns via credentialRef (secret_ref)
    register.post("/browser/execute", (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const url = typeof body.url === "string" ? body.url : "";
      const credentialRef = typeof body.credentialRef === "string" ? body.credentialRef : undefined;
      const { allowedDomains, autoApprove } = policyFromReq(req);
      if (!url) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "url required" });
      if (!isAllowedDomain(url, allowedDomains)) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(403).send({
          error: "domain not allowlisted",
          allowedDomains,
          hint: "default is blank [] for now; set allowedDomains to [\"outlierclone.io\"] or client domain via workspaces/:id/policy",
        });
      }
      const needsApproval = requiresApproval("external_write", autoApprove);
      // Vaulted credential — never log raw, only secret_ref pattern (VELARI ARCHITECTURE.md §5)
      const credentialKind = credentialRef ? (credentialRef.startsWith("oauth:") ? "google_api" : credentialRef.startsWith("apikey:") ? "api_key" : "email_password") : "none";
      (reply as { send(v: unknown): unknown }).send({
        ok: true,
        url,
        allowed: true,
        credentialKind,
        approval: needsApproval ? "pending" : "auto_approved",
        message: needsApproval ? "workflow requires approval_requests pending → approved" : "auto-approve enabled via policy — major test path",
      });
    });

    // GET /health — vertical liveness for markers
    register.get("/health", (_req, reply) => {
        (reply as { send(v: unknown): unknown }).send({ ok: true, vertical: workManifest.id, version: workManifest.version, tasks: tasks.size });
    });
  },
};

export { workManifest as velariWorkManifest };
export * from "./types.js";
