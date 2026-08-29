/**
 * Bridges workspace configuration (provider connections + model profiles)
 * to the provider-neutral router: builds ModelCandidate lists, resolves
 * BYOK secrets only at call time, and records usage after each call.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ChatMessage, ModelRequest } from "@app/contracts";
import type { AIProvider, InvokeOutcome, ModelCandidate, RequestContext } from "@app/ai-runtime";
import {
  AnthropicProvider,
  CircuitBreakerRegistry,
  LocalEchoProvider,
  OpenAICompatibleProvider,
  route,
} from "@app/ai-runtime";
import { privacyAllows } from "@app/security";
import { secretBox } from "../secrets.js";
import { METRICS, increment, newTraceId } from "@app/observability";

const PROVIDER_CATALOG: Record<string, () => AIProvider> = {
  openai: () => new OpenAICompatibleProvider("openai", "https://api.openai.com/v1", "gpt-4o-mini", "managed"),
  groq: () => new OpenAICompatibleProvider("groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "byok"),
  deepseek: () => new OpenAICompatibleProvider("deepseek", "https://api.deepseek.com/v1", "deepseek-chat", "byok"),
  bai: () => new OpenAICompatibleProvider("bai", "https://api.b.ai/v1", "qwen3.8-flash", "managed"),
  anthropic: () => new AnthropicProvider(),
  local: () => new LocalEchoProvider(),
};

export interface WorkspaceAiConfig {
  candidates: ModelCandidate[];
  providers: Map<string, AIProvider>;
  /** provider â†’ sealed secret_ref (resolved per call). */
  secrets: Map<string, string | undefined>;
  privacyMode: "local_only" | "byok_only" | "managed_allowed";
}

export async function loadWorkspaceAiConfig(db: PrismaClient, workspaceId: string): Promise<WorkspaceAiConfig> {
  const [connections, profiles, workspace] = await Promise.all([
    db.providerConnection.findMany({ where: { workspaceId, status: "active" } }),
    db.modelProfile.findMany({ where: { workspaceId, enabled: true } }),
    db.workspace.findUnique({ where: { id: workspaceId } }),
  ]);

  const policy = (workspace?.policyJson ?? {}) as { privacyMode?: string };
  const privacyMode =
    policy.privacyMode === "local_only" || policy.privacyMode === "byok_only"
      ? policy.privacyMode
      : "managed_allowed";

  const providers = new Map<string, AIProvider>();
  const secrets = new Map<string, string | undefined>();

  for (const conn of connections) {
    const factory = PROVIDER_CATALOG[conn.provider];
    if (!factory || !conn.secretRef) continue;
    const instance = factory();
    providers.set(conn.provider, instance);
    try {
      // Resolve at call time â€” plaintext never persisted or logged.
      secrets.set(conn.provider, secretBox.open(conn.secretRef));
    } catch {
      increment(METRICS.permissionDenials);
      secrets.set(conn.provider, undefined);
    }
  }
  // Always-available graceful-degradation candidate.
  const local = new LocalEchoProvider();
  providers.set(local.id, local);

  // Managed-mode fallback: platform-held keys from environment.
  if (!secrets.has("openai") || !secrets.get("openai")) {
    const managedKey = process.env.OPENAI_API_KEY;
    if (managedKey) secrets.set("openai", managedKey);
  }
  if (!secrets.has("bai") || !secrets.get("bai")) {
    const managedKey = process.env.BAI_API_KEY;
    if (managedKey) secrets.set("bai", managedKey);
  }
  if (!secrets.has("groq") || !secrets.get("groq")) {
    const managedKey = process.env.GROQ_API_KEY;
    if (managedKey) secrets.set("groq", managedKey);
  }

  const candidates: ModelCandidate[] = [];
  const profileByTask = new Map(profiles.map((p) => [p.taskClass, p]));

  for (const [providerId, provider] of providers) {
    const health = await provider.health();
    const caps = await provider.capabilities();
    const isLocal = providerId === "local" || providerId === "ollama";
    const hasSecret = Boolean(secrets.get(providerId));
    // Managed platforms (platform-held keys) vs bring-your-own-key vendors.
    const mode: ModelCandidate["privacyMode"] = isLocal
      ? "local"
      : providerId === "openai" && !hasSecret
        ? "managed"
        : "byok";
    const primary = profileByTask.get(profileTaskFor(caps))?.primaryModel as { model?: string } | null | undefined;
    candidates.push({
      providerId,
      model: primary?.model ?? defaultModelFor(providerId),
      capabilities: caps,
      privacyMode: mode === "managed" && !privacyAllows(privacyMode, "managed") ? "byok" : mode,
      healthScore: health.score,
      avgLatencyMs: providerId === "local-echo" ? 40 : 900,
      costPer1kMicros: isLocal ? 0 : providerId === "groq" ? 200 : providerId === "bai" ? 150 : 800,
      qualityScore: isLocal ? 0.4 : providerId === "anthropic" ? 0.95 : 0.85,
    });
  }

  return { candidates, providers, secrets, privacyMode };
}

function profileTaskFor(caps: string[]): string {
  return caps.includes("speech_to_text") ? "realtime_stt" : "live_coach";
}

function defaultModelFor(providerId: string): string {
  switch (providerId) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-sonnet-4-5";
    case "groq":
      return "llama-3.3-70b-versatile";
    case "deepseek":
      return "deepseek-chat";
    case "bai":
      // Measured winner on the b.ai gateway: only qwen3.8-flash streams with
      // live TTFT (benchmarks/results/coach.json); the others buffer ~20-25s.
      return "qwen3.8-flash";
    default:
      return "local-echo";
  }
}

export interface RouteDeps {
  db: PrismaClient;
  breakers: CircuitBreakerRegistry;
}

/** Execute a model request through the full router with usage recording. */
export async function executeRouted(
  deps: RouteDeps,
  cfg: WorkspaceAiConfig,
  workspaceId: string,
  sessionId: string | null,
  request: ModelRequest & { messages: ChatMessage[] },
): Promise<InvokeOutcome> {
  const traceId = newTraceId();
  const eligible = cfg.candidates.filter((c) => privacyAllows(cfg.privacyMode, c.privacyMode));

  const outcome = await route(
    request,
    {
      workspaceId,
      requestId: randomUUID(),
      traceId,
      secret: undefined, // resolved per candidate below
    },
    eligible,
    (c) => deps.breakers.penaltyFor(workspaceId, c.providerId, c.model, request.taskClass),
    (c) => deps.breakers.check(workspaceId, c.providerId, c.model, request.taskClass),
    async (c, _attempt): Promise<InvokeOutcome> => {
      const provider = cfg.providers.get(c.providerId);
      if (!provider) return { ok: false };
      const ctx: RequestContext = {
        workspaceId,
        requestId: randomUUID(),
        traceId,
        secret: cfg.secrets.get(c.providerId),
      };
      const result = await provider.execute(request, ctx);
      if (result.ok) {
        deps.breakers.recordSuccess(workspaceId, c.providerId, c.model, request.taskClass);
      } else if (result.error?.isFailoverEligible) {
        deps.breakers.recordFailure(workspaceId, c.providerId, c.model, request.taskClass);
        increment(METRICS.providerFallbacks);
      }
      await recordUsage(deps.db, {
        workspaceId,
        sessionId,
        providerId: c.providerId,
        model: c.model,
        requestType: request.taskClass,
        outcome: result.ok ? "success" : `error:${result.error?.kind ?? "unknown"}`,
        inputUnits: result.inputUnits ?? 0,
        outputUnits: result.outputUnits ?? 0,
        latencyMs: result.latencyMs ?? 0,
        traceId,
      });
      return result;
    },
  ).catch((e: unknown) => ({
    ok: false as const,
    error: e instanceof Error ? e.message : String(e),
  }));

  return outcome as InvokeOutcome;
}

async function recordUsage(
  db: PrismaClient,
  u: {
    workspaceId: string;
    sessionId: string | null;
    providerId: string;
    model: string;
    requestType: string;
    outcome: string;
    inputUnits: number;
    outputUnits: number;
    latencyMs: number;
    traceId: string;
  },
): Promise<void> {
  try {
    await db.usageRecord.create({
      data: {
        workspaceId: u.workspaceId,
        sessionId: u.sessionId,
        provider: u.providerId,
        model: u.model,
        requestType: u.requestType,
        inputUnits: BigInt(u.inputUnits),
        outputUnits: BigInt(u.outputUnits),
        latencyMs: u.latencyMs,
        estimatedCostMicros: BigInt(0), // priced by pricing table later
        outcome: u.outcome,
      },
    });
  } catch {
    // usage must never break the session path; surfaced via metrics instead
    increment("usage.record.failed");
  }
}

