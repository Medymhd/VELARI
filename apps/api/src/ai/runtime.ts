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

export interface WorkspaceProfile {
  taskClass: string;
  primaryModel: { model?: string; providerId?: string };
  fallbackModels: { model?: string; providerId?: string }[];
}

export interface WorkspaceAiConfig {
  candidates: ModelCandidate[];
  providers: Map<string, AIProvider>;
  /** provider — sealed secret_ref (resolved per call). */
  secrets: Map<string, string | undefined>;
  privacyMode: "local_only" | "byok_only" | "managed_allowed";
  /** Per-task routing policy (Settings "Model routing") applied in executeRouted. */
  profiles: WorkspaceProfile[];
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
    // Custom OpenAI-compatible endpoints: metadata carries their endpoint and
    // model (Settings BYOK flow) — the catalog's hardcoded defaults don't apply.
    const meta = (conn.metadataJson ?? {}) as { baseUrl?: string; modelId?: string };
    const factory = PROVIDER_CATALOG[conn.provider];
    if (!conn.secretRef || (!factory && !meta.baseUrl)) continue;
    const instance = meta.baseUrl
      ? new OpenAICompatibleProvider(conn.provider, meta.baseUrl, meta.modelId ?? defaultModelFor(conn.provider), "byok")
      : factory!();
    providers.set(conn.provider, instance);
    try {
      // Resolve at call time — plaintext never persisted or logged.
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
    candidates.push({
      providerId,
      model: defaultModelFor(providerId),
      capabilities: caps,
      privacyMode: mode === "managed" && !privacyAllows(privacyMode, "managed") ? "byok" : mode,
      healthScore: health.score,
      avgLatencyMs: providerId === "local-echo" ? 40 : 900,
      costPer1kMicros: isLocal ? 0 : providerId === "groq" ? 200 : providerId === "bai" ? 150 : 800,
      qualityScore: isLocal ? 0.4 : providerId === "anthropic" ? 0.95 : 0.85,
    });
  }

  return {
    candidates,
    providers,
    secrets,
    privacyMode,
    profiles: profiles.map((p) => ({
      taskClass: p.taskClass,
      primaryModel: (p.primaryModel ?? {}) as WorkspaceProfile["primaryModel"],
      fallbackModels: (p.fallbackModels ?? []) as WorkspaceProfile["fallbackModels"],
    })),
  };
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

/**
 * Vision-capable default per provider — text-only models (groq llama-3.3,
 * deepseek-chat) reject image input outright, so vision requests are
 * constrained to providers with a multimodal default. A saved openai-compat
 * connection keeps whatever model the user configured.
 */
function visionDefaults(): Record<string, string> {
  return {
    openai: "gpt-4o-mini",
    groq: "meta-llama/llama-4-scout-17b-16e-instruct",
    bai: process.env.OPENAI_COMPAT_VISION_MODEL ?? "deepseek-v4-flash-vision-exp",
    openrouter: process.env.OPENROUTER_VISION_MODEL ?? "minimax/minimax-m3:free",
  };
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

  // Routing chain: the task's profile primary, then its fallbacks in order,
  // then remaining candidates. Provider-scoped overrides — a profile naming
  // providerId X only reshapes X's model; unmatched picks default to the
  // first eligible candidate.
  let chain = eligible;
  const profile = cfg.profiles.find((p) => p.taskClass === request.taskClass);
  if (profile) {
    const pick = (ref: { model?: string; providerId?: string }): ModelCandidate | null => {
      if (!ref.model) return null;
      const base = ref.providerId
        ? eligible.find((c) => c.providerId === ref.providerId)
        : eligible[0];
      return base ? { ...base, model: ref.model } : null;
    };
    const head = [
      pick(profile.primaryModel),
      ...profile.fallbackModels.map((f) => pick(f)),
    ].filter((c): c is ModelCandidate => c != null);
    if (head.length > 0) {
      const seen = new Set(head.map((c) => `${c.providerId}:${c.model}`));
      chain = [...head, ...eligible.filter((c) => !seen.has(`${c.providerId}:${c.model}`))];
    }
  }

  // Vision requests: constrain to providers with a multimodal default and
  // swap in the vision model — a text-only model just answers "no image
  // support" and the request is wasted.
  if (request.taskClass === "vision") {
    const defaults = visionDefaults();
    const visionChain = chain
      .filter((c) => c.providerId in defaults || c.providerId === "openai-compat")
      .map((c) => (defaults[c.providerId] ? { ...c, model: defaults[c.providerId]! } : c));
    if (visionChain.length > 0) chain = visionChain;
  }

  const outcome = await route(
    request,
    {
      workspaceId,
      requestId: randomUUID(),
      traceId,
      secret: undefined, // resolved per candidate below
    },
    chain,
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
      return { ...result, providerId: c.providerId };
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

