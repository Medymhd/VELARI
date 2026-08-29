import type { ChatMessage, ModelRequest } from "@app/contracts";
import { CircuitBreakerRegistry } from "./circuitBreaker.js";
import { scoreCandidates } from "./router.js";
import type { ModelCandidate } from "./provider.js";

export interface VisionImage {
  base64: string;
  mimeType: string; // image/png | image/jpeg
}

export interface VisionRequest {
  prompt: string;
  images: VisionImage[];
  privacyMode: ModelRequest["privacyMode"];
  maxLatencyMs?: number;
}

/**
 * Vision fallback chain — port of rival `VisionProviderFallbackChain.ts` +
 * `visionStreamFallback.ts`. Orders candidates by health TTFT (EMA alpha 0.2
 * in rival) and tries next on 429/503/504/timeout.
 *
 * Providers that expose `vision` capability are preferred; others are skipped.
 */
export async function visionFallback(
  req: VisionRequest,
  candidates: ModelCandidate[],
  breakers: CircuitBreakerRegistry,
  workspaceId: string,
  invoke: (c: ModelCandidate) => Promise<{ ok: boolean; text?: string; error?: unknown }>,
): Promise<{ ok: boolean; text: string; providerId?: string }> {
  const visionCandidates = candidates.filter((c) => c.capabilities.includes("vision"));
  const pool = visionCandidates.length > 0 ? visionCandidates : candidates;

  // Rank by same scoring as text (health/latency/privacy) — vision health is TTFT
  const ranked = scoreCandidates(pool, { taskClass: "live_coach", privacyMode: req.privacyMode } as ModelRequest, (c) =>
    breakers.penaltyFor(workspaceId, c.providerId, c.model, "live_coach"),
  )
    .map((s) => s.candidate)
    .filter((c) => breakers.check(workspaceId, c.providerId, c.model, "live_coach").allowed);

  for (const c of ranked) {
    try {
      const r = await invoke(c);
      if (r.ok && r.text) {
        breakers.recordSuccess(workspaceId, c.providerId, c.model, "live_coach");
        return { ok: true, text: r.text, providerId: c.providerId };
      }
      breakers.recordFailure(workspaceId, c.providerId, c.model, "live_coach");
    } catch {
      breakers.recordFailure(workspaceId, c.providerId, c.model, "live_coach");
    }
  }
  return { ok: false, text: "" };
}

export function buildVisionMessages(req: VisionRequest): ChatMessage[] {
  // OpenAI-standard multipart content; adapters pass `messages` through verbatim.
  return [
    {
      role: "user",
      content: [
        { type: "text", text: req.prompt },
        ...req.images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        })),
      ],
    },
  ];
}
