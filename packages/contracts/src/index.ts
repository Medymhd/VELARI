/**
 * Platform contracts.
 *
 * Single source of truth for DTOs, realtime events, model-request
 * contracts and vertical manifests. Every app/package depends on
 * these schemas â€” never redefine them locally (architecture doc Â§3).
 */
import { z } from "zod";

export { z };

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Identity & tenancy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const WorkspaceRole = z.enum(["owner", "admin", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const UserStatus = z.enum(["active", "suspended", "deleted"]);

export const UserDto = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  status: UserStatus,
  createdAt: z.string().datetime(),
});
export type UserDto = z.infer<typeof UserDto>;

export const WorkspaceDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  plan: z.string(),
  policyJson: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Permissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const Permission = z.enum([
  "microphone",
  "system_audio",
  "screen_capture",
  "local_notifications",
  "credential_storage",
  "calendar.read",
  "gmail.read",
  "gmail.send",
  "social.publish",
  "crm.write",
]);
export type Permission = z.infer<typeof Permission>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Model / AI runtime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const ModelCapability = z.enum([
  "chat",
  "structured_output",
  "streaming",
  "speech_to_text",
  "text_to_speech",
  "embeddings",
  "vision",
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const TaskClass = z.enum(["realtime_stt", "live_coach", "deep_analysis", "tts"]);
export type TaskClass = z.infer<typeof TaskClass>;

export const PrivacyMode = z.enum(["local_only", "byok_only", "managed_allowed"]);
export type PrivacyMode = z.infer<typeof PrivacyMode>;

/** OpenAI-standard content parts — string content stays valid for text-only calls. */
export const ChatContentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }),
  }),
]);

export const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ChatContentPart)]),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ModelRequest = z.object({
  taskClass: TaskClass,
  messages: z.array(ChatMessage).optional(),
  responseSchema: z.record(z.unknown()).optional(),
  maxLatencyMs: z.number().int().positive().optional(),
  maxCostMicros: z.number().int().nonnegative().optional(),
  privacyMode: PrivacyMode,
  stream: z.boolean().optional(),
});
export type ModelRequest = z.infer<typeof ModelRequest>;

export const ModelResponse = z.object({
  text: z.string(),
  structured: z.record(z.unknown()).nullable(),
  providerId: z.string(),
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
  inputUnits: z.number().int().nonnegative(),
  outputUnits: z.number().int().nonnegative(),
  traceId: z.string(),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const ProviderHealth = z.object({
  score: z.number().min(0).max(1),
  lastError: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type ProviderHealth = z.infer<typeof ProviderHealth>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Interview vertical â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const SessionStatus = z.enum(["draft", "live", "paused", "completed", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ConsentStatus = z.enum(["pending", "confirmed", "not_required"]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const RetentionPolicy = z.enum(["retain_90d", "retain_30d", "delete_on_end"]);
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const TranscriptSource = z.enum(["local_stt", "cloud_stt", "imported"]);

export const TranscriptSegmentDto = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequenceNo: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative(),
  text: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  isFinal: z.boolean(),
  source: TranscriptSource,
  /** Speaker attribution when the capture channel is known (native dual-channel). */
  speaker: z.enum(["user", "interviewer"]).optional(),
});
export type TranscriptSegmentDto = z.infer<typeof TranscriptSegmentDto>;

export const InsightType = z.enum(["suggested_answer", "question", "summary", "action"]);

export const SessionInsightDto = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: InsightType,
  sourceSegmentIds: z.array(z.string().uuid()),
  contentJson: z.record(z.unknown()),
  modelTraceId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type SessionInsightDto = z.infer<typeof SessionInsightDto>;

export const InterviewSessionDto = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string().nullable(),
  status: SessionStatus,
  consentStatus: ConsentStatus,
  retentionPolicy: RetentionPolicy,
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  metadataJson: z.record(z.unknown()),
});
export type InterviewSessionDto = z.infer<typeof InterviewSessionDto>;

/** Structured coaching payload requested by the live pipeline (Â§7). */
export const CoachingPayload = z.object({
  detected_question: z.string(),
  suggested_outline: z.array(z.string()),
  talking_points: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  requires_user_review: z.boolean(),
});
export type CoachingPayload = z.infer<typeof CoachingPayload>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Realtime envelope â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const RealtimeEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transcript.partial"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    sessionId: z.string().uuid(),
    segment: TranscriptSegmentDto,
  }),
  z.object({
    type: z.literal("transcript.final"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    sessionId: z.string().uuid(),
    segment: TranscriptSegmentDto,
  }),
  z.object({
    type: z.literal("coach.suggestion"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    sessionId: z.string().uuid(),
    insight: SessionInsightDto,
  }),
  z.object({
    type: z.literal("session.status"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    sessionId: z.string().uuid(),
    status: SessionStatus,
  }),
  z.object({
    type: z.literal("pipeline.warning"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("pipeline.error"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/** Client â†’ server frames on the realtime socket. */
export const RealtimeClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio.chunk"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    /** base64-encoded PCM/opus chunk */
    payloadB64: z.string(),
    format: z.enum(["pcm_s16le_16k", "opus_48k"]),
    /** Capture source when known (native capture). Absent = browser mic. */
    channel: z.enum(["mic", "system"]).optional(),
  }),
  z.object({
    type: z.literal("transcript.client_final"),
    eventId: z.string(),
    sequenceNo: z.number().int().nonnegative(),
    occurredAt: z.string().datetime(),
    segment: TranscriptSegmentDto.omit({ id: true, sessionId: true }),
  }),
  z.object({ type: z.literal("ping"), eventId: z.string() }),
]);
export type RealtimeClientFrame = z.infer<typeof RealtimeClientFrame>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Vertical SDK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const AgentRisk = z.enum(["read", "external_write", "sensitive"]);

export const AgentToolSchema = z.object({
  id: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  risk: AgentRisk,
});
export type AgentToolSchema = z.infer<typeof AgentToolSchema>;

export const VerticalRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string(),
  handlerId: z.string(),
});
export type VerticalRouteSchema = z.infer<typeof VerticalRouteSchema>;

export const OverlayMode = z.enum(["stealth", "assist", "none"]);
export type OverlayMode = z.infer<typeof OverlayMode>;

export const VerticalManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  displayName: z.string(),
  requiredCapabilities: z.array(ModelCapability),
  requiredPermissions: z.array(Permission),
  routes: z.array(VerticalRouteSchema),
  tools: z.array(AgentToolSchema),
  retentionDefaults: RetentionPolicy,
  // Overlay capability — lets 10 apps share 1 shell with 3 behaviors without hard-coding:
  // stealth (interview hidden), assist (code/sheet visible), none (research immersive)
  overlay: z
    .object({
      mode: OverlayMode,
      size: z.tuple([z.number(), z.number()]).optional(),
    })
    .optional(),
});
export type VerticalManifest = z.infer<typeof VerticalManifest>;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Stealth module contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * Contract between the desktop stealth plugin and the rest of the platform.
 * The red team gets this exact list in the handoff brief â€” the point of the
 * exercise is detection, so the surface is documented, not hidden.
 */
export const MasqueradeProfile = z.enum(["none", "notepad", "terminal", "explorer", "settings", "custom"]);
export type MasqueradeProfile = z.infer<typeof MasqueradeProfile>;

export const StealthState = z.object({
  captureExclusion: z.boolean(),
  taskbarHidden: z.boolean(),
  masquerade: MasqueradeProfile,
  masqueradeTitle: z.string().nullable(),
  enforcedAtMs: z.number().int().nonnegative(),
});
export type StealthState = z.infer<typeof StealthState>;

