import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { newAssemblerState, ingestSegment } from "@app/domain";
import { RealtimeClientFrame } from "@app/contracts";
import { CircuitBreakerRegistry, createSttEngine, type SttEngine } from "@app/ai-runtime";
import { verifyToken } from "../auth.js";
import { logger } from "@app/observability";
import {
  buildCoachMessages,
  buildChunkSummaryMessages,
  createJudgeState,
  judgeSuggestion,
  type CoachFramework,
} from "@app/vertical-interview-intelligence";
import { captureStyleProfile, withStyle, type StyleProfile } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";

const log = logger({ svc: "realtime" });
const breakers = new CircuitBreakerRegistry();

/** GET /v1/realtime â€” WebSocket upgrade. Client auth via ?token=&sessionId= */
export function registerRealtime(app: FastifyInstance, db: PrismaClient): void {
  // fastify-websocket registers `app.get` with { websocket: true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get("/v1/realtime", { websocket: true }, async (socket: any, req: any) => {
    const query = req.query as { sessionId?: string; token?: string };
    const token = query.token ?? (req.headers.authorization as string | undefined)?.replace("Bearer ", "");
    const sessionId = query.sessionId;

    if (!sessionId || !token) {
      socket.send(JSON.stringify({ type: "pipeline.error", code: "missing_params", message: "sessionId and token required", recoverable: false }));
      socket.close(1008);
      return;
    }

    const auth = verifyToken(token);
    if (!auth) {
      socket.send(JSON.stringify({ type: "pipeline.error", code: "unauthorized", message: "invalid token", recoverable: false }));
      socket.close(1008);
      return;
    }

    const session = await db.interviewSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      socket.send(JSON.stringify({ type: "pipeline.error", code: "not_found", message: "session not found", recoverable: false }));
      socket.close(1008);
      return;
    }
    if (session.ownerUserId !== auth.userId) {
      const member = await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: session!.workspaceId, userId: auth.userId } },
      });
      if (!member) {
        socket.send(JSON.stringify({ type: "pipeline.error", code: "forbidden", message: "not a member", recoverable: false }));
        socket.close(1008);
        return;
      }
    }
    if (session.status !== "live") {
      socket.send(JSON.stringify({ type: "pipeline.warning", code: "session_not_live", message: `session status is ${session.status}` }));
    }

    const traceId = randomUUID();
    log.info("realtime connected", { traceId, sessionId: session!.id, workspaceId: session!.workspaceId });

    let serverSeq = 0;
    const seenClientIds = new Set<string>();
    const assembler = newAssemblerState();
    let lastFinalIds: string[] = [];
    let coachTimer: ReturnType<typeof setTimeout> | null = null;
    let workspaceCfg: Awaited<ReturnType<typeof loadWorkspaceAiConfig>> | null = null;

    // Dual-channel STT: native capture tags chunks mic|system → user|interviewer
    // attribution. Browser (channel-less) chunks share the default engine.
    const sttOpts: {
      deepgramKey?: string;
      localWhisperAvailable?: boolean;
      localWhisperUrl?: string;
      sherpaModelDir?: string;
    } = {};
    const sttEngines = new Map<string, SttEngine>();
    const engineFor = (channel?: string): SttEngine => {
      const key = channel ?? "default";
      let engine = sttEngines.get(key);
      if (!engine) {
        engine = createSttEngine(sttOpts);
        sttEngines.set(key, engine);
      }
      return engine;
    };
    const judge = createJudgeState();
    let rollingSummary: string | undefined;
    let finalsSinceSummary = 0;

    try {
      workspaceCfg = await loadWorkspaceAiConfig(db, session!.workspaceId);
      sttOpts.deepgramKey = workspaceCfg.secrets.get("deepgram") ?? process.env.DEEPGRAM_API_KEY;
      sttOpts.localWhisperAvailable = process.env.LOCAL_WHISPER_AVAILABLE === "1";
      const localWhisperUrl = process.env.LOCAL_WHISPER_URL;
      if (localWhisperUrl) sttOpts.localWhisperUrl = localWhisperUrl;
      const sherpaModelDir = process.env.SHERPA_MODEL_DIR;
      if (sherpaModelDir) sttOpts.sherpaModelDir = sherpaModelDir;
      log.info("STT engine config", { hasDeepgram: !!sttOpts.deepgramKey });
    } catch (e) {
      log.warn("failed to load workspace AI config, using local fallback", { error: String(e) });
    }

    function emit(obj: Record<string, unknown>): void {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* socket closed */
      }
    }

    // Initial status push
    emit({
      type: "session.status",
      eventId: randomUUID(),
      sequenceNo: serverSeq++,
      occurredAt: new Date().toISOString(),
      sessionId: session!.id,
      status: session.status,
    });

    async function handleFinal(text: string, confidence: number, startedAtMs: number, endedAtMs: number, source: string, speaker?: "user" | "interviewer"): Promise<void> {
      const sequenceNo = assembler.nextSequenceNo;
      const segmentId = randomUUID();
  const segment = {
    id: segmentId,
    sessionId: session!.id,
    sequenceNo,
    startedAtMs,
    endedAtMs,
    text,
    confidence,
    isFinal: true,
    source,
    ...(speaker ? { speaker } : {}),
    createdAt: new Date().toISOString(),
  };

  // Persist (speaker rides along — attribution must survive reload/Review)
  try {
    await db.transcriptSegment.create({
      data: {
        id: segmentId,
        sessionId: session!.id,
        sequenceNo,
        startedAtMs,
        endedAtMs,
        text,
        confidence,
        isFinal: true,
        source,
        ...(speaker ? { speaker } : {}),
      },
    });
  } catch (e) {
    log.warn("failed to persist transcript segment", { error: String(e) });
  }

      try {
        ingestSegment(assembler, segment as never, `srv:${segmentId}`);
      } catch {
        /* assembler ordering edge â€” non-fatal */
      }

      lastFinalIds = [...lastFinalIds.slice(-4), segmentId];

      emit({
        type: "transcript.final",
        eventId: randomUUID(),
        sequenceNo: serverSeq++,
        occurredAt: new Date().toISOString(),
        sessionId: session!.id,
        segment,
      });

      finalsSinceSummary += 1;
      if (finalsSinceSummary >= 8) {
        finalsSinceSummary = 0;
        void summarizeChunk();
      }

      scheduleCoaching();
    }

    /** Rolling ~30s chunk summary feeding the coach's context window (§7). */
    async function summarizeChunk(): Promise<void> {
      if (!workspaceCfg) return;
      const chunk = assembler.finals.slice(-8).map((s: { text: string }) => s.text).join("\n");
      if (!chunk) return;
      try {
        const outcome = await executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "live_coach",
            privacyMode: workspaceCfg.privacyMode,
            messages: buildChunkSummaryMessages(chunk, rollingSummary),
            responseSchema: {
              type: "object",
              properties: { summary: { type: "string" }, open_question: { type: "string" } },
              required: ["summary", "open_question"],
            },
          } as never,
        );

        let parsed: { summary?: string; open_question?: string } | null = null;
        if (outcome.ok && outcome.structured) {
          parsed = outcome.structured as { summary?: string; open_question?: string };
        } else if (outcome.ok && outcome.text) {
          try {
            parsed = JSON.parse(outcome.text) as { summary?: string; open_question?: string };
          } catch {
            parsed = null;
          }
        }
        if (!parsed?.summary) return;

        rollingSummary = parsed.summary;
        const insightId = randomUUID();
        try {
          await db.sessionInsight.create({
            data: {
              id: insightId,
              sessionId: session!.id,
              type: "summary",
              sourceSegmentIds: [],
              contentJson: { chunk_summary: parsed.summary, open_question: parsed.open_question ?? "" } as any,
              modelTraceId: traceId,
            },
          });
        } catch (e) {
          log.warn("failed to persist chunk summary", { error: String(e) });
        }

        emit({
          type: "coach.suggestion",
          eventId: randomUUID(),
          sequenceNo: serverSeq++,
          occurredAt: new Date().toISOString(),
          sessionId: session!.id,
          insight: {
            id: insightId,
            sessionId: session!.id,
            type: "summary",
            sourceSegmentIds: [],
            contentJson: { chunk_summary: parsed.summary, open_question: parsed.open_question ?? "" },
            modelTraceId: traceId,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (e) {
        log.warn("chunk summary failed", { error: String(e) });
      }
    }

    function scheduleCoaching(): void {
      if (coachTimer) clearTimeout(coachTimer);
      coachTimer = setTimeout(async () => {
        if (!workspaceCfg) return;
        const verbatim = assembler.finals.slice(-6).map((s: { text: string }) => s.text).join("\n") || lastFinalIds.join(" ");
        // Style adaptation: learn the user's voice from their own transcript
        // lines so the coach output reads naturally in their register.
        const userLines = assembler.finals.slice(-12)
          .filter((s: { speaker?: string; text: string }) => s.speaker === "user" || !s.speaker)
          .map((s: { text: string }) => s.text);
        const styleProfile: StyleProfile | undefined = userLines.length >= 3
          ? captureStyleProfile(userLines)
          : undefined;
        const messages = buildCoachMessages({
          verbatimTranscript: verbatim.slice(-4000) || "No transcript yet.",
          rollingSummary,
        });
        if (styleProfile) {
          messages[0] = { ...messages[0]!, content: withStyle(messages[0]!.content as string, styleProfile) };
        }

        try {
          const outcome = await executeRouted(
            { db, breakers },
            workspaceCfg,
            session!.workspaceId,
            session!.id,
            {
              taskClass: "live_coach",
              privacyMode: workspaceCfg.privacyMode,
              messages,
              responseSchema: {
                type: "object",
                properties: {
                  detected_question: { type: "string" },
                  suggested_outline: { type: "array", items: { type: "string" } },
                  talking_points: { type: "array", items: { type: "string" } },
                  confidence: { type: "number" },
                  requires_user_review: { type: "boolean" },
                },
                required: ["detected_question", "suggested_outline", "talking_points", "confidence", "requires_user_review"],
              },
            } as never,
          );

          let contentJson: Record<string, unknown>;
          if (outcome.ok && outcome.structured) {
            contentJson = outcome.structured as Record<string, unknown>;
          } else if (outcome.ok && outcome.text) {
            try {
              contentJson = JSON.parse(outcome.text) as Record<string, unknown>;
            } catch {
              contentJson = { raw: outcome.text, confidence: 0.4, requires_user_review: true };
            }
          } else {
            contentJson = {
              detected_question: verbatim.slice(-200),
              suggested_outline: ["Context", "Challenge", "Action", "Result"],
              talking_points: ["State your role and the stakes", "Name the decision you owned", "Close with a measurable outcome"],
              confidence: 0.35,
              requires_user_review: true,
            };
          }

          // Auto-answer judge: filter weak/repetitive output before UI + persistence.
          const verdict = judgeSuggestion(judge, contentJson as unknown as CoachFramework, Date.now());
          if (!verdict.accept) {
            log.info("coach suggestion filtered", { reason: verdict.reason });
            return;
          }

          const insightId = randomUUID();
          try {
            await db.sessionInsight.create({
              data: {
                id: insightId,
                sessionId: session!.id,
                type: "suggested_answer",
                sourceSegmentIds: lastFinalIds.slice(-3),
                contentJson: contentJson as any,
                modelTraceId: traceId,
              },
            });
          } catch (e) {
            log.warn("failed to persist insight", { error: String(e) });
          }

          emit({
            type: "coach.suggestion",
            eventId: randomUUID(),
            sequenceNo: serverSeq++,
            occurredAt: new Date().toISOString(),
            sessionId: session!.id,
            insight: {
              id: insightId,
              sessionId: session!.id,
              type: "suggested_answer",
              sourceSegmentIds: lastFinalIds.slice(-3),
              contentJson: contentJson as any,
              modelTraceId: traceId,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (e) {
          log.warn("coaching pipeline failed", { error: String(e) });
          emit({
            type: "pipeline.warning",
            eventId: randomUUID(),
            sequenceNo: serverSeq++,
            occurredAt: new Date().toISOString(),
            code: "coach_failed",
            message: String(e),
          });
        }
      }, 900);
    }

    socket.on("message", async (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        emit({ type: "pipeline.warning", eventId: randomUUID(), sequenceNo: serverSeq++, occurredAt: new Date().toISOString(), code: "bad_json", message: "invalid JSON frame" });
        return;
      }

      const frameResult = RealtimeClientFrame.safeParse(parsed);
      if (!frameResult.success) {
        emit({ type: "pipeline.warning", eventId: randomUUID(), sequenceNo: serverSeq++, occurredAt: new Date().toISOString(), code: "bad_frame", message: frameResult.error.message.slice(0, 400) });
        return;
      }
      const frame = frameResult.data;
      if ("eventId" in frame && seenClientIds.has(frame.eventId)) return;
      if ("eventId" in frame) seenClientIds.add(frame.eventId);

      if (frame.type === "ping") {
        emit({ type: "pipeline.warning", eventId: randomUUID(), sequenceNo: serverSeq++, occurredAt: new Date().toISOString(), code: "pong", message: frame.eventId });
        return;
      }

      if (frame.type === "audio.chunk") {
        const pcm = Buffer.from(frame.payloadB64, "base64");
        const nowMs = Date.now();
        const engine = engineFor(frame.channel);
        const speaker = frame.channel === "system" ? "interviewer" : frame.channel === "mic" ? "user" : undefined;
        engine.feed(pcm, nowMs, (result) => {
          // Defer socket writes out of the engine's synchronous decode loop —
          // sync sends from inside a native (napi) callback stack corrupt the
          // recognizer's decode state.
          queueMicrotask(() => {
            if (!result.isFinal) {
              emit({
                type: "transcript.partial",
                eventId: randomUUID(),
                sequenceNo: serverSeq++,
                occurredAt: new Date().toISOString(),
                sessionId: session!.id,
                segment: {
                  id: randomUUID(),
                  sessionId: session!.id,
                  sequenceNo: assembler.nextSequenceNo,
                  startedAtMs: nowMs,
                  endedAtMs: nowMs + 400,
                  text: result.text,
                  confidence: result.confidence,
                  isFinal: false,
                  source: engine.source,
                  ...(speaker ? { speaker } : {}),
                },
              });
            } else {
              void handleFinal(result.text, result.confidence, result.startedAtMs, result.endedAtMs, engine.source, speaker);
            }
          });
        });
        return;
      }

      if (frame.type === "transcript.client_final") {
        const s = frame.segment;
        await handleFinal(s.text, s.confidence ?? 0.9, s.startedAtMs, s.endedAtMs, s.source, s.speaker);
        return;
      }
    });

    socket.on("close", () => {
      if (coachTimer) clearTimeout(coachTimer);
      // Flush every engine so trailing audio finalizes instead of being lost
      // when the client stops sending (partial-only sessions otherwise end
      // with zero persisted segments).
      for (const [channel, engine] of sttEngines) {
        try {
          engine.flush((r) => {
            if (r.isFinal && r.text.trim()) {
              const speaker = channel === "system" ? "interviewer" : channel === "mic" ? "user" : undefined;
              void handleFinal(r.text, r.confidence, r.startedAtMs, r.endedAtMs, engine.source, speaker);
              log.info("flush final on disconnect", { sessionId: session!.id, channel, chars: r.text.length });
            } else {
              log.info("flush on disconnect produced no text", { sessionId: session!.id, channel });
            }
          });
        } catch (e) {
          log.warn("flush on disconnect failed", { sessionId: session!.id, channel, error: String(e) });
        }
        engine.close?.();
      }
      log.info("realtime disconnected", { traceId, sessionId: session!.id });
    });

    socket.on("error", (err: unknown) => {
      log.warn("realtime socket error", { error: String(err), traceId });
    });
  });
}

