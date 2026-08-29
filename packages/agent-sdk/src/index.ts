/**
 * App Agent SDK â€” runtime contracts a vertical must satisfy.
 * The API validates every installed vertical against these types at boot
 * and enforces approval policy on any tool flagged external_write/sensitive.
 */
import type {
  AgentToolSchema,
  VerticalManifest,
} from "@app/contracts";

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


