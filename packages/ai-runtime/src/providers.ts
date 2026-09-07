import type { ModelRequest } from "@app/contracts";
import {
  AIProvider,
  InvokeOutcome,
  ProviderError,
  ProviderHealthState,
  RequestContext,
} from "./provider.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, Groq, DeepSeek,
 * Azure OpenAI, LM Studio, Ollama's compat layer. One adapter, many providers.
 */
export class OpenAICompatibleProvider extends AIProvider {
  readonly id: string;
  private lastError: string | null = null;
  private healthScore = 1;

  constructor(
    id: string,
    private readonly baseUrl: string,
    private readonly defaultModel: string,
    private readonly privacyMode: "local" | "byok" | "managed" = "byok",
  ) {
    super();
    this.id = id;
  }

  async capabilities(): Promise<string[]> {
    return ["chat", "structured_output", "streaming", "vision"];
  }

  async health(): Promise<ProviderHealthState> {
    return { score: this.healthScore, lastError: this.lastError, updatedAt: Date.now() };
  }

  /** Task-scoped model resolution (probe-based, never hardcoded):
   *  COACH_MODEL_<GATEWAY> > COACH_MODEL > catalog default. The probe script
   *  (benchmarks/probe-models.mjs / pnpm bench:models) benchmarks every live
   *  gateway model and writes the winners into .env — a deprecated, removed
   *  or rate-limited model is replaced automatically on the next probe run
   *  instead of 404-ing every call silently. */
  private modelFor(request: ModelRequest): string {
    const prefix = `COACH_MODEL_${this.id.toUpperCase().replace(/-/g, "_")}`;
    const byTask =
      request.taskClass === "vision"
        ? process.env[`VISION_MODEL_${this.id.toUpperCase().replace(/-/g, "_")}`] ?? process.env.VISION_MODEL
        : process.env[prefix] ?? process.env.COACH_MODEL;
    return byTask && byTask.length > 0 ? byTask : this.defaultModel;
  }

  async execute(request: ModelRequest, ctx: RequestContext): Promise<InvokeOutcome> {
    const started = Date.now();
    if (!ctx.secret && this.privacyMode !== "local") {
      return err(new ProviderError("auth", `No credential resolved for ${this.id}`));
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), request.maxLatencyMs ?? 20_000);
    // Superseded live calls (interruption preemption) cancel the in-flight
    // HTTP request — frees the provider slot instead of letting it drain.
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    // 2048 default: reasoning models (gpt-oss) burn completion tokens on
    // analysis before the JSON payload — 300-class budgets trip "max
    // completion tokens reached" and the strict schema never validates.
    // Task-scoped budgets (maxTokens) shrink completion time for tight
    // contracts like the live coach.
    const body = {
      model: this.modelFor(request),
      messages: request.messages ?? [],
      max_tokens: request.maxTokens ?? 2048,
      ...(request.responseSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "app_output", schema: request.responseSchema, strict: true },
            },
          }
        : {}),
    };
    try {
      let res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(ctx.secret ? { authorization: `Bearer ${ctx.secret}` } : {}),
          "x-request-id": ctx.requestId,
        },
        body: JSON.stringify(body),
      });
      // Strict json_schema rejected by the provider/model (HTTP 400) — retry
      // once without it and parse the plain text leniently.
      if (!res.ok && request.responseSchema && res.status === 400) {
        const { response_format: _dropped, ...plain } = body as Record<string, unknown>;
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(ctx.secret ? { authorization: `Bearer ${ctx.secret}` } : {}),
            "x-request-id": ctx.requestId,
          },
          body: JSON.stringify(plain),
        });
      }
      const payload = (await res.json()) as ChatCompletionResponse;
      if (!res.ok || payload.error) {
        throw classifyHttp(res.status, payload.error?.message ?? res.statusText);
      }
      let text = payload.choices?.[0]?.message?.content ?? "";
      let structured: Record<string, unknown> | null = null;
      if (request.responseSchema) {
        try {
          structured = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Lenient retry (no-schema fallback path): strip code fences and
          // take the outermost {...} before giving up.
          const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ""));
          if (m) {
            try {
              structured = JSON.parse(m[0]) as Record<string, unknown>;
              text = m[0];
            } catch {
              throw new ProviderError("invalid_output", "Model returned non-JSON for structured request");
            }
          } else {
            throw new ProviderError("invalid_output", "Model returned non-JSON for structured request");
          }
        }
      }
      this.healthScore = Math.min(1, this.healthScore + 0.05);
      this.lastError = null;
      return ok(text, structured, Date.now() - started, payload.usage);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("connection", String(e));
      this.lastError = pe.message;
      this.healthScore = Math.max(0, this.healthScore - 0.2);
      return err(pe);
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

type AnthropicResponse = {
  content?: Array<{ text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export class AnthropicProvider extends AIProvider {
  readonly id = "anthropic";
  private lastError: string | null = null;
  private healthScore = 1;

  constructor(private readonly model = "claude-sonnet-4-5") {
    super();
  }

  async capabilities(): Promise<string[]> {
    return ["chat", "structured_output", "streaming", "vision"];
  }

  async health(): Promise<ProviderHealthState> {
    return { score: this.healthScore, lastError: this.lastError, updatedAt: Date.now() };
  }

  async execute(request: ModelRequest, ctx: RequestContext): Promise<InvokeOutcome> {
    const started = Date.now();
    if (!ctx.secret) return err(new ProviderError("auth", "No Anthropic key resolved"));
    const system = request.messages?.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = request.messages?.filter((m) => m.role !== "system") ?? [];
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), request.maxLatencyMs ?? 20_000);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.secret,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        }),
      });
      const body = (await res.json()) as AnthropicResponse;
      if (!res.ok || body.error) throw classifyHttp(res.status, body.error?.message ?? res.statusText);
      const text = body.content?.map((c) => c.text ?? "").join("") ?? "";
      this.healthScore = Math.min(1, this.healthScore + 0.05);
      this.lastError = null;
      return ok(text, null, Date.now() - started, {
        prompt_tokens: body.usage?.input_tokens,
        completion_tokens: body.usage?.output_tokens,
      });
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("connection", String(e));
      this.lastError = pe.message;
      this.healthScore = Math.max(0, this.healthScore - 0.2);
      return err(pe);
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Deterministic local provider. Two roles:
 *  - graceful-degradation fallback when all cloud candidates are down;
 *  - demo/test mode so the full pipeline runs with zero keys configured.
 */
export class LocalEchoProvider extends AIProvider {
  readonly id = "local-echo";
  async capabilities(): Promise<string[]> {
    return ["chat", "structured_output"];
  }
  async health(): Promise<ProviderHealthState> {
    return { score: 1, lastError: null, updatedAt: Date.now() };
  }
  async execute(request: ModelRequest): Promise<InvokeOutcome> {
    const lastUser = [...(request.messages ?? [])].reverse().find((m) => m.role === "user");
    const raw = lastUser?.content ?? "";
    const transcript =
      typeof raw === "string" ? raw : raw.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (request.taskClass === "live_coach") {
      const structured: Record<string, unknown> = {
        detected_question: extractQuestion(transcript),
        suggested_outline: ["Context", "Challenge", "Action", "Result"],
        talking_points: [
          "Anchor on one specific example with measurable outcome",
          "Name your role and the tradeoff you owned",
          "Close with what you learned and would repeat",
        ],
        confidence: 0.55,
        requires_user_review: true,
      };
      return ok(JSON.stringify(structured), structured, 12, {
        prompt_tokens: Math.ceil(transcript.length / 4),
        completion_tokens: 64,
      });
    }
    // Deterministic offline echo for chat-style tasks (research, deep_analysis):
    // the honest free-local answer until a real provider is configured.
    return ok(
      transcript || "No input received.",
      null,
      12,
      { prompt_tokens: Math.ceil(transcript.length / 4), completion_tokens: 32 },
    );
  }
}

/* â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function ok(
  text: string,
  structured: Record<string, unknown> | null,
  latencyMs: number,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): InvokeOutcome {
  return {
    ok: true,
    text,
    structured,
    latencyMs,
    inputUnits: usage?.prompt_tokens ?? 0,
    outputUnits: usage?.completion_tokens ?? 0,
  };
}

function err(e: ProviderError): InvokeOutcome {
  return { ok: false, error: e };
}

export function classifyHttp(status: number, message: string): ProviderError {
  switch (true) {
    case status === 401 || status === 403:
      return new ProviderError("auth", message, status);
    case status === 429:
      return new ProviderError("rate_limited", message, status);
    case status === 503 || status === 504:
      return new ProviderError("unavailable", message, status);
    case status >= 500:
      return new ProviderError("connection", message, status);
    case status >= 400:
      return new ProviderError("invalid_input", message, status);
    default:
      return new ProviderError("connection", message, status);
  }
}

export function extractQuestion(transcript: string): string {
  const questions = transcript.split(/(?<=[.?])\s+/).filter((s) => s.includes("?"));
  return questions.at(-1)?.slice(0, 300) ?? transcript.slice(-160).trim();
}


