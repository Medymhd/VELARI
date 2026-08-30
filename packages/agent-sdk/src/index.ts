/**
 * App Agent SDK â€” runtime contracts a vertical must satisfy.
 * The API validates every installed vertical against these types at boot
 * and enforces approval policy on any tool flagged external_write/sensitive.
 */
import type {
  AgentToolSchema,
  VerticalManifest,
} from "@app/contracts";

function parseHost(url: string): string | null {
  try {
    const idx = url.indexOf("://");
    if (idx === -1) return null;
    const rest = url.slice(idx + 3);
    const slashIdx = rest.indexOf("/");
    const host = (slashIdx === -1 ? rest : rest.slice(0, slashIdx)).toLowerCase();
    const colonIdx = host.indexOf(":");
    return colonIdx === -1 ? host : host.slice(0, colonIdx);
  } catch {
    return null;
  }
}

export interface ToolContext {
  workspaceId: string;
  userId: string;
  agentRunId: string;
  traceId: string;
}

export interface ToolResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

/** A vertical-provided tool implementation (handler behind the schema). */
export interface AgentToolImpl {
  schema: AgentToolSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface VerticalRegistration {
  manifest: VerticalManifest;
  tools?: AgentToolImpl[];
  /** Fastify-compatible route factory: receives the scoped prefix path and
   *  platform services (db). Verticals stay decoupled from Prisma imports. */
  registerRoutes?: (app: RouteRegistrar, services: VerticalServices) => void;
}

/** Platform services handed to verticals at mount time. */
export interface VerticalServices {
  /** PrismaClient instance — typed as unknown here to keep the SDK
   *  framework- and ORM-agnostic; verticals narrow it on their side. */
  db: unknown;
  /** Resolves a credential ref to plaintext at call time (vault-sealed or
   *  inline for dev). Returns null when the ref cannot be opened. Never log
   *  the result. */
  openSecret?: (credentialRef: string) => string | null;
  /** Platform AI seam — routes through the BYOK router (scoring, breakers,
   *  usage ledger) so verticals never touch provider code directly. */
  ai?: {
    ask(input: {
      workspaceId: string;
      taskClass: string;
      messages: unknown[];
      responseSchema?: unknown;
    }): Promise<{ text: string; structured?: unknown; providerId?: string }>;
  };
}

/**
 * Minimal structural subset of Fastify the SDK relies on â€” keeps verticals
 * decoupled from the concrete server framework.
 */
export interface RouteRegistrar {
  get(path: string, handler: (req: unknown, reply: ReplyLike) => unknown): unknown;
  post(path: string, handler: (req: unknown, reply: ReplyLike) => unknown): unknown;
  patch(path: string, handler: (req: unknown, reply: ReplyLike) => unknown): unknown;
  delete(path: string, handler: (req: unknown, reply: ReplyLike) => unknown): unknown;
}

export interface ReplyLike {
  status(code: number): { send(body: unknown): unknown };
  send(body: unknown): unknown;
}

export function validateRegistration(reg: VerticalRegistration): string[] {
  const problems: string[] = [];
  for (const tool of reg.tools ?? []) {
    if (tool.schema.risk !== "read") {
      // External writes must be surfaced to the platform approval engine.
      if (!tool.schema.inputSchema || Object.keys(tool.schema.inputSchema).length === 0) {
        problems.push(`tool ${tool.schema.id}: risky tools require an input schema`);
      }
    }
  }
  return problems;
}

// ── Shared vertical helpers (hoisted from work-assistant §E) ──────────────

/** Narrow `services.db` to a typed facade without importing Prisma in verticals. */
export interface WorkspaceDb {
  workspaceMember: {
    findUnique(args: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }): Promise<unknown>;
  };
  auditEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/** Tenancy gate — returns true if the user is a member of the workspace. */
export async function canAccessWorkspace(db: unknown, workspaceId: string, userId: string): Promise<boolean> {
  const wdb = db as WorkspaceDb;
  const member = await wdb.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return Boolean(member);
}

/** Write an audit event (fire-and-forget — audit must never break the route). */
export async function writeVerticalAudit(db: unknown, entry: {
  workspaceId: string;
  actorId: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  metadataJson?: Record<string, unknown>;
}): Promise<void> {
  const wdb = db as WorkspaceDb;
  try {
    await wdb.auditEvent.create({
      data: { ...entry, actorType: "user" },
    });
  } catch {
    // audit must never break the route
  }
}

/** Domain allowlist check — default blank [] blocks until policy is set. */
export function isDomainAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return false;
  const host = parseHost(url);
  if (!host) return false;
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Approval gate: external_write requires approval unless autoApprove is set. */
export function needsApproval(risk: string, autoApprove: boolean): boolean {
  return risk === "external_write" && !autoApprove;
}


