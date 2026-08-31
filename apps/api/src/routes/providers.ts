import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CircuitBreakerRegistry } from "@app/ai-runtime";
import type { ModelInfo, ModelFeature, ModelModality } from "@app/contracts";
import { secretBox } from "../secrets.js";
import { writeAudit } from "../audit.js";
import { toJson } from "../db.js";
import { assertRole } from "./workspaces.js";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";

const breakers = new CircuitBreakerRegistry();

/** Known-provider endpoints — mirrors the runtime catalog (metadataJson overrides these). */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  bai: "https://api.b.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  bai: "qwen3.8-flash",
};

/** Normalize a user-supplied OpenAI-compatible base URL (http(s), trailing slash trimmed). */
function normalizeBaseUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Map a raw OpenAI-compatible /models entry to the shared ModelInfo contract. */
function toModelInfo(m: Record<string, unknown>): ModelInfo {
  const arch = (m.architecture ?? {}) as {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  const params = (m.supported_parameters ?? []) as string[];
  const pricingRaw = (m.pricing ?? {}) as Record<string, string>;
  const num = (v: string | undefined) => (v ? Number(v) * 1_000_000 : undefined); // per-token → per-million
  const features: ModelFeature[] = ["streaming"];
  if ((arch.input_modalities ?? []).includes("image")) features.push("images");
  if ((arch.input_modalities ?? []).includes("video")) features.push("video");
  if (params.includes("tools")) features.push("tools");
  if (params.includes("reasoning")) features.push("reasoning", "reasoning-effort");
  if (params.includes("structured_outputs")) features.push("structured_output");
  if (params.includes("temperature")) features.push("temperature");
  const cacheRead = num(pricingRaw.input_cache_read);
  const cacheWrite = num(pricingRaw.input_cache_write);
  if (cacheRead != null || cacheWrite != null) features.push("prompt-cache");
  return {
    id: String(m.id ?? ""),
    name: typeof m.name === "string" ? m.name : undefined,
    contextWindow: typeof m.context_length === "number" ? m.context_length : undefined,
    maxTokens: typeof m.max_completion_tokens === "number" ? m.max_completion_tokens : undefined,
    features,
    modalities: {
      input: (arch.input_modalities ?? []) as ModelModality[],
      output: (arch.output_modalities ?? []) as ModelModality[],
    },
    pricing: {
      input: num(pricingRaw.prompt),
      output: num(pricingRaw.completion),
      cacheRead,
      cacheWrite,
    },
  };
}

/** Fetch the model catalog for a base URL (OpenRouter's is public; others may need the key). */
async function fetchModels(baseUrl: string, secret?: string): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.map(toModelInfo).filter((m) => m.id.length > 0);
}

export function providerRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/provider-connections", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      provider?: string;
      authMode?: string;
      secret?: string;
      capabilities?: string[];
      baseUrl?: string;
      modelId?: string;
      fallbackModelIds?: string[];
    };
    if (!body.workspaceId || !body.provider || !body.secret) {
      return reply.status(400).send({ error: "workspaceId, provider and secret are required" });
    }
    // OpenAI-compatible custom endpoints carry their endpoint + model in metadata.
    let baseUrl: string | undefined;
    if (body.provider === "openai-compat") {
      if (!body.baseUrl) return reply.status(400).send({ error: "baseUrl is required for openai-compat providers" });
      baseUrl = normalizeBaseUrl(body.baseUrl);
      if (!baseUrl) return reply.status(400).send({ error: "baseUrl must be a valid http(s) URL" });
    }
    if (!(await assertRole(db, userId, body.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }

    const sealed = secretBox.seal(body.secret);
    const conn = await db.providerConnection.create({
      data: {
        workspaceId: body.workspaceId,
        provider: body.provider,
        authMode: body.authMode ?? "byok",
        secretRef: sealed.sealed,
        status: "active",
        capabilities: (body.capabilities ?? []) as any,
        metadataJson: {
          ...(baseUrl ? { baseUrl } : {}),
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.fallbackModelIds?.length ? { fallbackModelIds: body.fallbackModelIds } : {}),
        } as any,
      },
    });
    await writeAudit(db, {
      workspaceId: body.workspaceId,
      actorType: "user",
      actorId: userId,
      eventType: "provider.connected",
      resourceType: "provider_connection",
      resourceId: conn.id,
      metadataJson: { provider: body.provider },
    });

    // Never echo the secret or its material.
    return reply.status(201).send(toJson({ ...conn, secretRef: undefined, hasSecret: true }));
  });

  /**
   * Model catalog proxy: GET {baseUrl}/models on behalf of the workspace.
   * OpenRouter's catalog is public (keyless probe first); other endpoints may
   * require the connection's key — resolved from the vault at call time only.
   */
  app.post("/v1/provider-connections/models", async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; baseUrl?: string; secret?: string };
    let baseUrl: string | undefined;
    let secret: string | undefined;
    if (body.connectionId) {
      const conn = await db.providerConnection.findUnique({ where: { id: body.connectionId } });
      if (!conn || conn.workspaceId === null || !(await assertRole(db, req.user!.userId, conn.workspaceId, ["owner", "admin", "member"]))) {
        return reply.status(404).send({ error: "connection not found" });
      }
      const meta = conn.metadataJson as { baseUrl?: string } | null;
      baseUrl = meta?.baseUrl ?? undefined;
      try {
        secret = conn.secretRef ? secretBox.open(conn.secretRef) : undefined;
      } catch { /* keyless probe fallback */ }
    } else if (body.baseUrl) {
      baseUrl = normalizeBaseUrl(body.baseUrl);
      secret = body.secret;
    }
    if (!baseUrl) return reply.status(400).send({ error: "connectionId or baseUrl required" });
    try {
      const models = await fetchModels(baseUrl, secret);
      return reply.send({ models });
    } catch (e) {
      return reply.status(502).send({ error: `model catalog fetch failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  /** One-token chat probe against a saved connection — deterministic connectivity test. */
  app.post("/v1/provider-connections/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await db.providerConnection.findUnique({ where: { id } });
    if (!conn) return reply.status(404).send({ error: "connection not found" });
    if (!(await assertRole(db, req.user!.userId, conn.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    if (!conn.secretRef) return reply.status(400).send({ error: "connection has no secret" });
    let secret: string;
    try {
      secret = secretBox.open(conn.secretRef);
    } catch {
      return reply.status(400).send({ error: "secret could not be unsealed" });
    }
    const meta = (conn.metadataJson ?? {}) as { baseUrl?: string; modelId?: string };
    const baseUrl = meta.baseUrl ?? PROVIDER_BASE_URLS[conn.provider] ?? undefined;
    const model = meta.modelId ?? PROVIDER_DEFAULT_MODELS[conn.provider];
    if (!baseUrl || !model) return reply.status(400).send({ error: `no endpoint known for provider ${conn.provider}` });

    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return reply.send({ ok: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}: ${detail}` });
      }
      return reply.send({ ok: true, latencyMs: Date.now() - started, model });
    } catch (e) {
      return reply.send({ ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/v1/provider-connections", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return [];
    const rows = await db.providerConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return toJson(rows.map((r) => ({ ...r, secretRef: undefined, hasSecret: Boolean(r.secretRef) })));
  });

  app.delete("/v1/provider-connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await db.providerConnection.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: "not found" });
    if (!(await assertRole(db, req.user!.userId, existing.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    await db.providerConnection.delete({ where: { id } });
    await writeAudit(db, {
      workspaceId: existing.workspaceId,
      actorType: "user",
      actorId: req.user!.userId,
      eventType: "provider.disconnected",
      resourceType: "provider_connection",
      resourceId: id,
    });
    return reply.send({ deleted: true });
  });

  app.get("/v1/model-profiles", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return [];
    const rows = await db.modelProfile.findMany({ where: { workspaceId } });
    return toJson(rows);
  });

  app.put("/v1/model-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      workspaceId?: string;
      name?: string;
      taskClass?: string;
      primaryModel?: Record<string, unknown>;
      fallbackModels?: Record<string, unknown>[];
      constraintsJson?: Record<string, unknown>;
      enabled?: boolean;
    };
    if (!body.workspaceId) return reply.status(400).send({ error: "workspaceId required" });
    if (!(await assertRole(db, req.user!.userId, body.workspaceId, ["owner", "admin"]))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    const saved = await db.modelProfile.upsert({
      where: { id },
      update: {
        name: body.name,
        taskClass: body.taskClass,
        primaryModel: (body.primaryModel ?? {}) as any,
        fallbackModels: (body.fallbackModels ?? []) as any,
        constraintsJson: (body.constraintsJson ?? {}) as any,
        enabled: body.enabled ?? true,
      },
      create: {
        id,
        workspaceId: body.workspaceId,
        name: body.name ?? "default",
        taskClass: body.taskClass ?? "live_coach",
        primaryModel: (body.primaryModel ?? {}) as any,
        fallbackModels: (body.fallbackModels ?? []) as any,
        constraintsJson: (body.constraintsJson ?? {}) as any,
        enabled: body.enabled ?? true,
      },
    });
    return reply.send(toJson(saved));
  });

  /** Probe a profile through the real router Ã¢â‚¬â€ proves failover wiring works. */
  app.post("/v1/model-profiles/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await db.modelProfile.findUnique({ where: { id } });
    if (!profile) return reply.status(404).send({ error: "not found" });

    const cfg = await loadWorkspaceAiConfig(db, profile.workspaceId);
    const started = Date.now();
    const outcome = await executeRouted(
      { db, breakers },
      cfg,
      profile.workspaceId,
      null,
      {
        taskClass: "live_coach",
        privacyMode: cfg.privacyMode,
        messages: [
          { role: "system", content: 'Reply with JSON {"ok":true}' },
          { role: "user", content: "Connectivity probe. Respond with the JSON." },
        ],
      },
    );
    return reply.send({
      ok: outcome.ok,
      latencyMs: Date.now() - started,
      providerId: outcome.ok ? undefined : outcome.error,
      textPreview: typeof outcome.text === "string" ? outcome.text.slice(0, 120) : undefined,
    });
  });
}

