import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import { newAssemblerState, ingestSegment } from "@app/domain";
import { RealtimeClientFrame } from "@app/contracts";
import { CircuitBreakerRegistry, createSttEngine, warmMoonshine, type SttEngine } from "@app/ai-runtime";
import { verifyToken } from "../auth.js";
import { logger } from "@app/observability";
import {
  buildCoachMessages,
  buildChunkSummaryMessages,
  buildAnswerMessages,
  createJudgeState,
  judgeSuggestion,
  sanitizeCoachFramework,
  stripLeakage,
  isInterviewMode,
  matchPreparedQa,
  type CoachFramework,
} from "@app/vertical-interview-intelligence";
import { captureStyleProfile, withStyle, type StyleProfile, createEmbeddingProvider } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";
import { AnswerCache, prepHashOf, questionTokens, keyHashFor } from "../services/answerCache.js";

const log = logger({ svc: "realtime" });
const breakers = new CircuitBreakerRegistry();

/** Boot-time STT warm: kick the Moonshine weight download/load before any
 *  session exists, so the FIRST session of the day opens hot too. The
 *  process-level weight cache makes every later warmup a no-op. Sherpa stays
 *  out of boot (its ensureSherpaModel download is heavier; it warms at first
 *  connect instead). */
let bootWarmDone = false;
export function bootWarmStt(): void {
  if (bootWarmDone) return;
  bootWarmDone = true;
  warmMoonshine();
  log.info("boot STT warm kicked (moonshine weights loading)");
}

/** GET /v1/realtime ” WebSocket upgrade. Client auth via ?token=&sessionId= */
export function registerRealtime(app: FastifyInstance, db: PrismaClient): void {
  // POST /v1/stt/warm — the client calls this the moment the user clicks
  // New/Open on Home, BEFORE navigating: warming starts during the screen
  // transition instead of after WS connect. Idempotent (weight cache); no
  // session required; auth optional by design (warming is side-effect-free).
  app.post("/v1/stt/warm", async (_req, reply) => {
    warmMoonshine();
    return reply.send({ ok: true, warming: "moonshine" });
  });

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
    let warmTimer: ReturnType<typeof setInterval> | null = null;
    /** Last real provider call (coach/draft/summary) — keep-warm pings back
     *  off while live traffic is flowing. */
    let lastCoachActivityAt = 0;
    let workspaceCfg: Awaited<ReturnType<typeof loadWorkspaceAiConfig>> | null = null;
    /** Mode persona (rival ModesManager parity) — client-switchable mid-session. */
    let sessionMode = "general";
    /** Response length preference (rival length modes): short | medium | long. */
    let sessionLength: "short" | "medium" | "long" = "medium";
    /** Whether the interviewer channel has produced any final this session.
     *  Mic speech coaches only while it hasn't: speakerphone/in-person calls
     *  deliver the interviewer through the mic (no loopback), so the mic IS
     *  the conversation until loopback audio appears — then it's just the
     *  user's own voice and coaching on it stops automatically. No toggle. */
    let sawInterviewer = false;
    /** Profile Intelligence persona — coach answers cite real background. */
    let personaContext: string | undefined;
    /** Session prep materials: CV/JD/notes text for the coach prompt, and the
     *  drilled Q&A bank for instant recall (no LLM latency). Reloadable
     *  mid-session via the session.reload_contexts frame. */
    let prepContext: string | undefined;
    let qaBank: { id: string; title: string; content: string }[] = [];
    /** Last Q&A the recall surfaced — one prepared answer per question. */
    let lastRecalledQaId = "";

    async function loadPrepMaterials(): Promise<void> {
      const contexts = await db.sessionContext.findMany({ where: { sessionId: session!.id } });
      if (contexts.length === 0) {
        prepContext = undefined;
        qaBank = [];
        return;
      }
      const byKind = (k: string) => contexts.filter((c) => c.kind === k);
      // Priority order = interview reality: the interviewer has already read
      // the CV and knows the JD. CV leads the join (biggest budget — the
      // draft's head-trim preserves it, and honesty depends on the model
      // seeing the full CV), but the JD is the objective every answer
      // optimizes for: JDs are short and dense, so the full text rides along
      // and the prompt contract frames every answer as proof-of-fit for it.
      prepContext = [
        ...byKind("cv").map((c) => `CV (${c.title}):\n${c.content.slice(0, 6000)}`),
        ...byKind("jd").map((c) => `Job description — the role to win (${c.title}):\n${c.content.slice(0, 4000)}`),
        ...byKind("notes").map((c) => `Prep notes (${c.title}):\n${c.content.slice(0, 2000)}`),
      ].join("\n\n") || undefined;
      qaBank = byKind("qa").map((c) => ({ id: c.id, title: c.title, content: c.content }));
      log.info("session prep loaded", { contexts: contexts.length, qaBank: qaBank.length });
    }

    // Dual-channel STT: native capture tags chunks mic|system → user|interviewer
    // attribution. Browser (channel-less) chunks share the default engine.
    const sttOpts: {
      deepgramKey?: string;
      localWhisperAvailable?: boolean;
      localWhisperUrl?: string;
      sherpaModelDir?: string;
    } = {};
    const sttEngines = new Map<string, SttEngine>();
    /** Per-channel partial/final recency — drives the staleness watchdog. */
    const channelAudio = new Map<string, { lastPartialAt: number; lastFinalAt: number }>();
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

    // Answer cache: tolerant lookup (exact → fuzzy → vector) before any LLM
    // call. Loaded with the workspace's recent accepted answers; seeded after
    // every judge-accepted insight. Quality guard: only accepted outputs enter.
    const embedder = createEmbeddingProvider({
      embeddingBaseUrl: process.env.EMBEDDING_BASE_URL,
      embeddingApiKey: process.env.EMBEDDING_API_KEY,
      embeddingModel: process.env.EMBEDDING_MODEL,
    });
    const answerCache = new AnswerCache(async (texts) => embedder.embed(texts));
    let activePrepHash = "";
    try {
      const rows = await db.answerCacheEntry.findMany({
        where: { workspaceId: session!.workspaceId },
        orderBy: { createdAt: "asc" },
        take: 500,
      });
      answerCache.load(rows.map((r) => ({
        id: r.id,
        question: r.question,
        tokensJson: r.tokensJson,
        embeddingJson: r.embeddingJson,
        frameworkJson: r.frameworkJson as Record<string, unknown>,
        answerText: r.answerText,
        mode: r.mode,
        length: r.length,
        prepHash: r.prepHash,
      })));
    } catch (e) {
      log.warn("answer cache load failed (cache disabled this session)", { error: String(e) });
    }

    /** Staleness watchdog: a partial hanging with no final (engine wedged,
     *  gate never closed) force-finalizes after 10s by flushing the engine —
     *  "70% partials get stuck" is a dead-end otherwise. */
    const staleTimer = setInterval(() => {
      const now = Date.now();
      for (const [channel, rec] of channelAudio) {
        if (rec.lastPartialAt > rec.lastFinalAt && now - rec.lastPartialAt > 10_000) {
          rec.lastFinalAt = now; // reset before flush to avoid re-trigger loops
          const engine = sttEngines.get(channel);
          if (engine) {
            log.info("stale partial — forcing flush", { sessionId: session!.id, channel });
            try {
              engine.flush((r) => {
                if (r.isFinal && r.text.trim()) {
                  const speaker = channel === "system" ? "interviewer" : channel === "mic" ? "user" : undefined;
                  void handleFinal(r.text, r.confidence, r.startedAtMs, r.endedAtMs, engine.source, speaker, utteranceId(channel));
                  advanceTurn(channel);
                }
              });
            } catch { /* engine already gone */ }
          }
        }
      }
    }, 5_000);

    try {
      // STT engine warmup FIRST — before config/DB awaits, so model loading
      // runs in parallel with workspace config, persona and prep loading.
      //
      // MOONSHINE ONLY — deliberately NOT the whole chain. FallbackSttEngine
      // warmup forwards through every rung, and eagerly building Sherpa's
      // ONNX recognizer in the API process crashes it: sherpa's bundled
      // onnxruntime.dll is 1.27.1 (C API v27) while Moonshine's
      // onnxruntime-node 1.24.3 (API v24) loads first, and Windows resolves
      // sherpa's import to the already-loaded module. Warm Moonshine
      // directly — a standalone engine shares the process-level weight
      // cache, so the real chain engines find hot weights when they init.
      warmMoonshine();
      log.info("STT engines warming (moonshine only)", { sessionId: session!.id });

      workspaceCfg = await loadWorkspaceAiConfig(db, session!.workspaceId);
      sttOpts.deepgramKey = workspaceCfg.secrets.get("deepgram") ?? process.env.DEEPGRAM_API_KEY;
      sttOpts.localWhisperAvailable = process.env.LOCAL_WHISPER_AVAILABLE === "1";
      const localWhisperUrl = process.env.LOCAL_WHISPER_URL;
      if (localWhisperUrl) sttOpts.localWhisperUrl = localWhisperUrl;
      const sherpaModelDir = process.env.SHERPA_MODEL_DIR;
      if (sherpaModelDir) sttOpts.sherpaModelDir = sherpaModelDir;
      // Profile Intelligence: persona feeds "Candidate role/context" so coach
      // answers cite the user's actual background.
      const persona = await db.profilePersona.findUnique({ where: { workspaceId: session!.workspaceId } });
      if (persona) {
        const p = persona.personaJson as { role?: string; seniority?: string; skills?: string[]; experienceHighlights?: string[] };
        personaContext = [
          p.role ? `Role: ${p.role}${p.seniority ? ` (${p.seniority})` : ""}` : "",
          p.skills?.length ? `Skills: ${p.skills.join(", ")}` : "",
          ...(p.experienceHighlights ?? []).slice(0, 3),
        ]
          .filter(Boolean)
          .join("\n");
      }
      log.info("STT engine config", { hasDeepgram: !!sttOpts.deepgramKey, hasPersona: !!personaContext });
      await loadPrepMaterials();

      // Provider warmup: the first real coach call otherwise pays DNS + TLS +
      // auth handshake (~0.3-1s) on the critical path while the candidate is
      // already answering. A 1-token ping at session start moves that cost
      // off the first question. Fire-and-forget; a failed ping is the same
      // signal the first real call would have hit, just earlier and cheaper.
      const hasRemote = [...workspaceCfg.providers.keys()].some((p) => p !== "local" && p !== "local-echo");
      if (hasRemote) {
        void executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "live_coach",
            privacyMode: workspaceCfg.privacyMode,
            messages: [{ role: "user", content: "." }],
            maxTokens: 1,
          } as never,
        ).catch(() => {});
      }
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

    // Connection warm-up: a tiny fire-and-forget request opens the TLS
    // connection and primes the provider so the first real coach call skips
    // the handshake cost. Never blocks; failures are free.
    if (workspaceCfg) {
      const warmRequest = {
        taskClass: "live_coach" as const,
        privacyMode: workspaceCfg.privacyMode,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 1,
        maxLatencyMs: 5_000,
      };
      const pingWarm = () => {
        // Idle discipline: real coach traffic already warmed the pool within
        // the last 30s — skip the ping so keep-warm never competes with live
        // answers for free-tier RPM.
        if (Date.now() - lastCoachActivityAt < 30_000) return;
        void executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          warmRequest as never,
        ).catch(() => {});
      };
      pingWarm();

      // Keep-warm: pooled sockets go stale after a few seconds of idle
      // (undici keep-alive + provider-side timeouts), so the connect-time
      // warmup alone is dead by the time the first question lands. Re-warm
      // every 60s for the life of the socket (skipped when live traffic is
      // already flowing) so the FIRST answer pays zero handshake.
      warmTimer = setInterval(pingWarm, 60_000);
    }

    /** Per-utterance segment ids: partials and their final share one id so the
     *  client renders ONE evolving line per speech turn that commits in place
     *  (dictation UX). The turn advances when a final is committed — the next
     *  partial starts a fresh line. */
    const utteranceTurn: Record<string, number> = {};
    const utteranceId = (channel: string | undefined): string => {
      const ch = channel ?? "default";
      utteranceTurn[ch] ??= 0;
      return `u-${ch}-${utteranceTurn[ch]}`;
    };
    const advanceTurn = (channel: string | undefined): void => {
      const ch = channel ?? "default";
      utteranceTurn[ch] = (utteranceTurn[ch] ?? 0) + 1;
    };

    async function handleFinal(text: string, confidence: number, startedAtMs: number, endedAtMs: number, source: string, speaker?: "user" | "interviewer", segmentId?: string): Promise<void> {
      // Echo dedup (rival `ECHO_WINDOW` parity): the mic hears the speaker's
      // output acoustically — if a user final near-identically repeats the
      // last interviewer final within 8s, it's echo, drop it.
      if (speaker === "user" && text.length > 8) {
        const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
        const lastIv = assembler.finals.filter((f: { speaker?: string }) => f.speaker === "interviewer").at(-1);
        if (lastIv) {
          const a = words(text);
          const b = words(String(lastIv.text));
          let shared = 0;
          for (const w of a) if (b.has(w)) shared += 1;
          if (a.size > 0 && shared / a.size > 0.8 && Math.abs(Date.now() - (lastIv.endedAtMs ?? 0)) < 8_000) {
            log.info("echo final dropped", { sessionId: session!.id, chars: text.length });
            return;
          }
        }
      }

      if (speaker === "interviewer") sawInterviewer = true;

      const sequenceNo = assembler.nextSequenceNo;
      const finalSegmentId = segmentId ?? randomUUID();
      const segment = {
        id: finalSegmentId,
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
        id: finalSegmentId,
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
        ingestSegment(assembler, segment as never, `srv:${finalSegmentId}`);
      } catch {
        /* assembler ordering edge ” non-fatal */
      }

      lastFinalIds = [...lastFinalIds.slice(-4), finalSegmentId];

      // Instant prepared-answer recall (rival knowledge-packs parity): match
      // interviewer questions against the drilled Q&A bank — ~0ms, ahead of
      // the LLM coach. One recall per question text. Mic speech matches too
      // while no interviewer audio exists (phone-mode sessions).
      // preparedServed suppresses the parallel verbatim draft for this final —
      // the bank already answered it at 0ms.
      let preparedServed = false;
      if ((speaker === "interviewer" || (speaker === "user" && !sawInterviewer)) && qaBank.length > 0) {
        const match = matchPreparedQa(text, qaBank);
        if (match && match.qa.id !== lastRecalledQaId) {
          preparedServed = true;
          lastRecalledQaId = match.qa.id;
          const insightId = randomUUID();
          const contentJson = {
            question: text.slice(0, 300),
            answer: match.answer,
            title: match.qa.title,
            score: Math.round(match.score * 100) / 100,
          };
          try {
            await db.sessionInsight.create({
              data: {
                id: insightId,
                sessionId: session!.id,
                type: "prepared_answer",
                sourceSegmentIds: [finalSegmentId],
                contentJson: contentJson as any,
                modelTraceId: traceId,
              },
            });
          } catch (e) {
            log.warn("failed to persist prepared answer", { error: String(e) });
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
              type: "prepared_answer",
              sourceSegmentIds: [finalSegmentId],
              contentJson: contentJson as any,
              modelTraceId: traceId,
              createdAt: new Date().toISOString(),
            },
          });
        }
      }

      emit({
        type: "transcript.final",
        eventId: randomUUID(),
        sequenceNo: serverSeq++,
        occurredAt: new Date().toISOString(),
        sessionId: session!.id,
        segment,
      });

      finalsSinceSummary += 1;
      // Summary runs only when the coach is idle — on rate-limited tiers the
      // two calls would queue behind each other and delay the live answer.
      // The counter persists, so the summary fires on a later quiet final.
      if (finalsSinceSummary >= 8 && !coachBusy) {
        finalsSinceSummary = 0;
        void summarizeChunk();
      }

      // Rival semantic (Cluely/LockedIn parity): the coach responds to the
      // interviewer's speech (loopback). Channel-less (browser mic) finals
      // count as interviewer. Until interviewer audio exists at all, mic
      // speech drives coaching — the mic is the only conversation in a
      // speakerphone/in-person session. Once loopback interviewer audio
      // appears, mic speech stops coaching (it's the user's own voice).
      if (speaker !== "user" || !sawInterviewer) {
        // Answer-first sequencing: a question-shaped final drafts the spoken
        // answer FIRST, then the framework coach runs after it settles. The
        // speakable answer lands after ONE LLM round-trip (instead of two
        // sequential ones), and there is never more than ONE concurrent call
        // — two concurrent calls trip free-tier 429s, which open breakers and
        // stall the whole pipeline (the regression this replaces).
        if (looksLikeQuestion(text) && !preparedServed && maybeClaimDraft(text)) {
          lastTriggerNorm = normalizeTrigger(text); // keep the coach gate in sync
          const tail = assembler.finals.slice(-6).map((s: { text: string }) => s.text).join("\n");
          const draft = draftAutoAnswer(text, tail.slice(-2000))
            .catch(() => {})
            .finally(() => { draftInFlight = false; });
          void Promise.race([draft, sleepMs(7_000)]).then(() => {
            if (coachBusy) scheduleCoaching(); // another framework is in flight — normal path
            else void runCoach();
          });
        } else {
          scheduleCoaching();
        }
      }
    }

    function sleepMs(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** Head-budget trim: keep whole paragraphs up to ~budget chars so the
     *  draft call carries lighter input without ever cutting mid-paragraph.
     *  CV leads the joined prep string, so it always survives the cut. */
    function headParagraphs(text: string | undefined, budget: number): string | undefined {
      if (!text || text.length <= budget) return text;
      const paras = text.split("\n\n");
      let out = "";
      for (const p of paras) {
        if ((out + p).length > budget && out) break;
        out += (out ? "\n\n" : "") + p;
      }
      return out || text.slice(0, budget);
    }

    function normalizeTrigger(t: string): string {
      return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    }

    /** Heuristic question shape — the fast path for the verbatim draft.
     *  Mirrors the overlay strip rule: '?' or a leading question word.
     *  Cheap and deterministic; the coach's normalized detection remains the
     *  authority for the framework card. */
    function looksLikeQuestion(t: string): boolean {
      const s = t.trim();
      if (!s) return false;
      if (s.includes("?")) return true;
      return /^(tell|what|how|why|when|who|where|walk|describe|explain|give|can you|could you|do you|did you|have you|are you|would you)\b/i.test(s);
    }

    /** Draft claim gate — the anti-storm guard for progressive/STT-repeat
     *  finals ("Tell me…" → "Tell me about…" → …). One draft at a time, one
     *  draft per normalized question, and a floor between drafts so a burst
     *  of finals can never fan out into a burst of provider calls. */
    let draftInFlight = false;
    let lastDraftKey = "";
    let lastDraftStartAt = 0;
    function maybeClaimDraft(text: string): boolean {
      const key = normalizeTrigger(text).slice(0, 120);
      if (draftInFlight) return false;
      if (key && key === lastDraftKey) return false;
      if (Date.now() - lastDraftStartAt < 4_000) return false;
      draftInFlight = true;
      lastDraftKey = key;
      lastDraftStartAt = Date.now();
      lastParallelDraftAt = Date.now(); // fallback defers to this draft
      return true;
    }

    /** Rolling ~30s chunk summary feeding the coach's context window (§7). */
    async function summarizeChunk(): Promise<void> {
      if (!workspaceCfg) return;
      const chunk = assembler.finals.slice(-8).map((s: { text: string }) => s.text).join("\n");
      if (!chunk) return;
      lastCoachActivityAt = Date.now();
      try {
        const outcome = await executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "chunk_summary",
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

    /** Single-flight coach control: a new trigger ABORTS any in-flight call
     *  (interruption preemption — the newest speech is the most urgent
     *  context) and the epoch discards results that finish after being
     *  superseded. This is what keeps provider slots free: no queued,
     *  stale, or duplicate coach calls piling up on rate-limited tiers. */
    let coachAbort: AbortController | null = null;
    let coachEpoch = 0;
    let coachBusy = false;

    /** Confirmation window: coaching fires only after the speaker has held
     *  still for this long. Every new final from the same conversation resets
     *  it, so a short mid-sentence pause never triggers a premature (wrong)
     *  answer. Wait-for-completion beats raw speed. */
    const COACH_CONFIRM_MS = 900;

    /** Junk-trigger gate state: the last normalized trigger text. */
    let lastTriggerNorm = "";

    /** Timestamp of the last heuristic verbatim draft. The coach's own draft
     *  trigger defers to it — one draft per question, whichever path fires
     *  first. */
    let lastParallelDraftAt = 0;

    function scheduleCoaching(): void {
      // Junk-trigger gate: backchannel fragments ("Love", "About yourself.")
      // and exact consecutive repeats burn provider quota and end as scaffolds
      // on rate-limited tiers. A subsequent substantive final re-schedules;
      // an in-flight coach call is left running (its context is still valid).
      const latest = String(assembler.finals.at(-1)?.text ?? "").trim();
      if (latest) {
        const norm = latest.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
        const words = norm.split(" ").filter(Boolean);
        if (words.length < 3 && !latest.includes("?")) return;
        if (norm && norm === lastTriggerNorm) return;
        lastTriggerNorm = norm;
      }
      // Preempt immediately: whatever the coach is crafting is already stale —
      // the conversation moved on.
      coachAbort?.abort();
      coachAbort = null;
      if (coachTimer) clearTimeout(coachTimer);
      coachTimer = setTimeout(() => {
        void runCoach();
      }, COACH_CONFIRM_MS);
    }

    async function runCoach(): Promise<void> {
      if (!workspaceCfg) return;
      coachAbort?.abort();
      const abort = new AbortController();
      coachAbort = abort;
      const epoch = ++coachEpoch;
      coachBusy = true;
      lastCoachActivityAt = Date.now();
      const startedAt = Date.now();
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
        mode: sessionMode,
        roleDescription: personaContext,
        prepContext,
        length: sessionLength,
      });
      if (styleProfile) {
        messages[0] = { ...messages[0]!, content: withStyle(messages[0]!.content as string, styleProfile) };
      }
      // Answer cache lookup BEFORE the LLM — a question asked (nearly) before
      // is answered in ~0ms. Hit quality is guaranteed: only judge-accepted,
      // sanitized outputs are ever cached, keyed by mode+length+prepHash.
      const prepHash = activePrepHash || (activePrepHash = prepHashOf(prepContext, qaBank));
      const lastQuestionLine = verbatim.split("\n").filter(Boolean).at(-1) ?? "";
      if (answerCache.size() > 0 && lastQuestionLine.length > 12) {
        try {
          const hit = await answerCache.lookup(lastQuestionLine, { mode: sessionMode, length: sessionLength, prepHash });
          if (hit) {
            log.info("answer cache hit", { sessionId: session!.id, tier: hit.key, score: hit.score });
            await db.answerCacheEntry.update({ where: { id: hit.id }, data: { hitCount: { increment: 1 } } }).catch(() => {});
            const contentJson: Record<string, unknown> = {
              ...hit.frameworkJson,
              cached: true,
              cache_tier: hit.key,
              cache_score: hit.score,
              cached_question: hit.matchedQuestion,
            };
            const insightId = randomUUID();
            await db.sessionInsight.create({
              data: {
                id: insightId,
                sessionId: session!.id,
                type: "suggested_answer",
                sourceSegmentIds: lastFinalIds.slice(-3),
                contentJson: contentJson as any,
                modelTraceId: traceId,
              },
            }).catch(() => {});
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
            return;
          }
        } catch (e) {
          log.warn("answer cache lookup failed (continuing to LLM)", { error: String(e) });
        }
      }
      // ASR confidence of the triggering speech — rides on the insight so the
      // UI can flag answers built on a misheard question ("low confidence —
      // verify" chip) instead of presenting a wrong answer as certain.
      const lastIvFinal = [...assembler.finals].reverse().find((s: { speaker?: string }) => s.speaker !== "user");
      const sttConfidence = typeof lastIvFinal?.confidence === "number" ? lastIvFinal.confidence : undefined;

      try {
        // Working indicator at first token (~TTFT): the panel and overlay show
        // "crafting…" instead of dead air for the remaining generation time.
        let workingEmitted = false;
        const outcome = await executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "live_coach",
            privacyMode: workspaceCfg.privacyMode,
            messages,
            maxTokens: 512,
            signal: abort.signal,
            onDelta: () => {
              if (workingEmitted || abort.signal.aborted) return;
              workingEmitted = true;
              emit({
                type: "coach.working",
                eventId: randomUUID(),
                sequenceNo: serverSeq++,
                occurredAt: new Date().toISOString(),
                sessionId: session!.id,
              });
            },
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
        // Superseded mid-flight (interruption or newer final): the result is
        // stale — discard silently, no UI noise, no persistence.
        if (epoch !== coachEpoch) {
          log.info("coach result discarded (superseded)", { sessionId: session!.id, waitedMs: Date.now() - startedAt });
          return;
        }
        log.info("coach latency", { sessionId: session!.id, ms: Date.now() - startedAt });

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
            // Every provider rung failed (rate limits, breakers, outage).
            // Never fabricate a card here — a transcript fragment pasted as a
            // "question" reads as broken output. Show the honest offline
            // scaffold and surface WHY, so the user can fix the provider.
            log.warn("coach unavailable — offline scaffold", { sessionId: session!.id, error: outcome.error ?? "no outcome" });
            emit({
              type: "pipeline.warning",
              eventId: randomUUID(),
              sequenceNo: serverSeq++,
              occurredAt: new Date().toISOString(),
              sessionId: session!.id,
              code: "coach_unavailable",
              message: typeof outcome.error === "string" ? outcome.error : "LLM provider unavailable — check keys/quota in Settings",
            });
            emitOfflineScaffold(verbatim);
            return;
          }

          // Post-process before judging (reference answerPolish parity): strip
          // JSON-envelope leakage / AI tells, compress to speakable lines.
          const sanitized = sanitizeCoachFramework(contentJson as unknown as CoachFramework);
          if (!sanitized) {
            log.info("coach suggestion dropped: nothing speakable after sanitize — offline scaffold shown");
            emitOfflineScaffold(verbatim);
            return;
          }
          contentJson = sanitized as unknown as Record<string, unknown>;
          if (sttConfidence !== undefined) contentJson.stt_confidence = sttConfidence;

          // Auto-answer judge: filter weak/repetitive output before UI + persistence.
          const verdict = judgeSuggestion(judge, contentJson as unknown as CoachFramework, Date.now());
          if (!verdict.accept) {
            // Duplicates are correct suppression (same question already answered);
            // everything else still shows the offline scaffold so the panel is
            // never silently empty.
            if (verdict.reason === "duplicate_question") {
              log.info("coach suggestion filtered", { reason: verdict.reason });
            } else {
              log.info("coach suggestion filtered — offline scaffold shown", { reason: verdict.reason });
              emitOfflineScaffold(verbatim);
            }
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

          // Seed the answer cache with the accepted answer so the same (or a
          // slightly reworded) question next time is answered without an LLM.
          try {
            const seedQuestion = String(contentJson.detected_question ?? lastQuestionLine).trim();
            if (seedQuestion.length > 12) {
              const [emb] = await embedder.embed([seedQuestion]).catch(() => [[] as number[]]);
              const entryId = randomUUID();
              // Prisma Json columns need InputJsonValue — cast through unknown.
              const frameworkJson = contentJson as unknown as Prisma.InputJsonValue;
              const entry = {
                id: entryId,
                workspaceId: session!.workspaceId,
                keyHash: keyHashFor({ question: seedQuestion, mode: sessionMode, length: sessionLength, prepHash }),
                question: seedQuestion,
                tokensJson: questionTokens(seedQuestion),
                embeddingJson: (emb ?? []) as unknown as Prisma.InputJsonValue,
                frameworkJson,
                answerText: (contentJson.talking_points as string[] | undefined)?.join(" ") ?? String(contentJson.detected_question ?? ""),
                mode: sessionMode,
                length: sessionLength,
                prepHash,
                hitCount: 0,
                sourceSessionId: session!.id,
              };
              await db.answerCacheEntry.upsert({
                where: { workspaceId_keyHash: { workspaceId: session!.workspaceId, keyHash: entry.keyHash } },
                create: entry,
                update: { frameworkJson, answerText: entry.answerText, embeddingJson: entry.embeddingJson, tokensJson: entry.tokensJson },
              });
              answerCache.seed({
                id: entryId,
                question: seedQuestion,
                tokens: entry.tokensJson as string[],
                embedding: emb ?? [],
                frameworkJson: contentJson,
                answerText: entry.answerText,
                mode: sessionMode,
                length: sessionLength,
                prepHash,
              });
            }
          } catch (e) {
            log.warn("answer cache seed failed (non-fatal)", { error: String(e) });
          }

          // Auto-answer pass (reference SimpleAutoAnswer parity): strong question
          // with high confidence → draft the exact spoken words. This is the
          // FALLBACK path — the heuristic draft (answer-first sequencing)
          // usually fired at final-commit and led the pipeline. Skip when that
          // already ran within the last 15s so a question is never drafted
          // twice; dedup in draftAutoAnswer still guards exact repeats.
          const q = String(contentJson.detected_question ?? "").trim();
          const conf = Number(contentJson.confidence ?? 0);
          // Draft gate 0.55: STT partial confidence (0.7) and marginal LLM
          // confidence must still draft — the judge and postProcess guard
          // quality; silence is the only unacceptable outcome.
          if (q && conf >= 0.55 && q.includes("?")) {
            if (Date.now() - lastParallelDraftAt > 15_000) {
              lastParallelDraftAt = Date.now();
              void draftAutoAnswer(q, verbatim.slice(-2000));
            }
          }
        } catch (e) {
          if (abort.signal.aborted) return; // superseded — silent by design
          log.warn("coaching pipeline failed", { error: String(e) });
          emit({
            type: "pipeline.warning",
            eventId: randomUUID(),
            sequenceNo: serverSeq++,
            occurredAt: new Date().toISOString(),
            code: "coach_failed",
            message: String(e),
          });
        } finally {
          coachBusy = false;
          if (coachAbort === abort) coachAbort = null;
        }
    }

    /** Always-answer fallback: when the LLM output is unusable, the user still
     *  gets a structural scaffold for the last heard question instead of a
     *  silently empty panel. Marked offline so the UI styles it honestly.
     *  Guarded: no scaffold for junk lines, and repeated failures within the
     *  window collapse into a single card instead of spamming the stack. */
    let lastScaffoldAt = 0;
    function emitOfflineScaffold(verbatim: string): void {
      const lines = verbatim.split("\n").filter(Boolean);
      // Prefer the last line that actually reads as a question; a bare tail
      // slice would cut mid-word ("…exp|erience across…") and read as broken.
      const questionish = [...lines].reverse().find((l) => l.includes("?")) ?? "";
      const raw = (questionish || lines.at(-1) || "").trim();
      // Junk gate: a fragment with no question shape isn't worth a scaffold —
      // stay silent and keep the last good card visible.
      const wordCount = raw.split(/\s+/).filter(Boolean).length;
      if (!raw || (wordCount < 4 && !raw.includes("?"))) return;
      // Throttle: identical failure bursts render one scaffold per 12s.
      const now = Date.now();
      if (now - lastScaffoldAt < 12_000) return;
      lastScaffoldAt = now;
      // Over-long lines keep only the tail — cut at a word boundary, never
      // inside a word.
      const trimmed = raw.length > 300 ? raw.slice(-300).replace(/^\S+\s/, "") : raw;
      const insightId = randomUUID();
      const contentJson = {
        detected_question: trimmed || "Question still forming…",
        suggested_outline: ["Direct answer first", "One concrete proof point", "Close with the outcome"],
        talking_points: ["Name the core answer in one sentence", "Back it with a specific project result"],
        confidence: 0.3,
        requires_user_review: true,
        offline: true,
      };
      void db.sessionInsight.create({
        data: {
          id: insightId,
          sessionId: session!.id,
          type: "suggested_answer",
          sourceSegmentIds: lastFinalIds.slice(-3),
          contentJson: contentJson as any,
          modelTraceId: traceId,
        },
      }).catch(() => {});
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
    }

    /** Question dedup for auto-answer — one draft per question text. */
    let lastAnsweredQuestion = "";

    async function draftAutoAnswer(question: string, transcriptTail: string): Promise<void> {
      if (!workspaceCfg) return;
      const key = question.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 120);
      if (key === lastAnsweredQuestion) return;
      lastAnsweredQuestion = key;
      lastCoachActivityAt = Date.now();
      try {
        const outcome = await executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "live_coach",
            privacyMode: workspaceCfg.privacyMode,
            maxLatencyMs: 12_000,
            messages: buildAnswerMessages({
              detectedQuestion: question,
              transcriptTail,
              rollingSummary,
              mode: sessionMode,
              length: sessionLength,
              // The verbatim answer is what the interviewer hears — it must
              // speak AS the candidate their CV describes (CV > JD > notes).
              // Trimmed to the head budget: CV leads the joined string so it
              // always survives; the framework call keeps the full context.
              prepContext: headParagraphs(prepContext, 6000),
              personaContext,
            }),
            // Two-part output: answer + optional grounding (extra CV example
            // the UI tints crimson). Fallbacks cover models that ignore JSON.
            responseSchema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                grounding: { type: "string" },
              },
              required: ["answer", "grounding"],
            },
          } as never,
        );
        // Answer + grounding: structured first, then JSON.parse, then the
        // whole text as the answer (no grounding) — providers on free tiers
        // can be sloppy with the schema and silence is never acceptable.
        let rawAnswer = "";
        let grounding = "";
        if (outcome.ok && outcome.structured) {
          const s = outcome.structured as { answer?: unknown; grounding?: unknown };
          rawAnswer = typeof s.answer === "string" ? s.answer : "";
          grounding = typeof s.grounding === "string" ? s.grounding : "";
          if (!rawAnswer && typeof outcome.text === "string") rawAnswer = outcome.text;
        } else if (outcome.ok && outcome.text) {
          try {
            const parsed = JSON.parse(outcome.text) as { answer?: unknown; grounding?: unknown };
            if (typeof parsed.answer === "string") {
              rawAnswer = parsed.answer;
              grounding = typeof parsed.grounding === "string" ? parsed.grounding : "";
            } else {
              rawAnswer = outcome.text;
            }
          } catch {
            rawAnswer = outcome.text;
          }
        }
        const answer = outcome.ok ? stripLeakage(rawAnswer).trim() : "";
        grounding = grounding ? stripLeakage(grounding).trim() : "";
        if (answer.split(/\s+/).length < 4) {
          log.info("auto-answer dropped: too short or failed");
          return;
        }
        const insightId = randomUUID();
        const contentJson: Record<string, unknown> = { question, answer, mode: sessionMode };
        if (grounding && grounding.split(/\s+/).length >= 4) contentJson.grounding = grounding.slice(0, 600);
        try {
          await db.sessionInsight.create({
            data: {
              id: insightId,
              sessionId: session!.id,
              type: "auto_answer",
              sourceSegmentIds: lastFinalIds.slice(-3),
              contentJson: contentJson as any,
              modelTraceId: traceId,
            },
          });
        } catch (e) {
          log.warn("failed to persist auto-answer", { error: String(e) });
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
            type: "auto_answer",
            sourceSegmentIds: lastFinalIds.slice(-3),
            contentJson: contentJson as any,
            modelTraceId: traceId,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (e) {
        log.warn("auto-answer failed", { error: String(e) });
      }
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

      if (frame.type === "session.mode") {
        if (isInterviewMode(frame.mode)) {
          sessionMode = frame.mode;
          log.info("session mode set", { mode: sessionMode, sessionId: session!.id });
        }
        return;
      }

      if (frame.type === "session.length") {
        if (["short", "medium", "long"].includes(frame.length)) {
          sessionLength = frame.length as "short" | "medium" | "long";
          log.info("session length set", { length: sessionLength, sessionId: session!.id });
        }
        return;
      }

      if (frame.type === "session.reload_contexts") {
        await loadPrepMaterials();
        activePrepHash = prepHashOf(prepContext, qaBank);
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
            const rec = channelAudio.get(frame.channel ?? "default") ?? { lastPartialAt: 0, lastFinalAt: 0 };
            channelAudio.set(frame.channel ?? "default", rec);
            if (!result.isFinal) {
              rec.lastPartialAt = nowMs;
              emit({
                type: "transcript.partial",
                eventId: randomUUID(),
                sequenceNo: serverSeq++,
                occurredAt: new Date().toISOString(),
                sessionId: session!.id,
                segment: {
                  // Stable per-utterance id: every partial of the same speech
                  // turn shares it, so the client UPDATES one evolving line
                  // (dictation UX) instead of appending a new row per revision.
                  id: utteranceId(frame.channel),
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
              rec.lastFinalAt = nowMs;
              // The final commits the partial row in place, then the turn
              // advances so the next utterance starts a fresh line.
              void handleFinal(result.text, result.confidence, result.startedAtMs, result.endedAtMs, engine.source, speaker, utteranceId(frame.channel));
              advanceTurn(frame.channel);
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
      if (staleTimer) clearInterval(staleTimer);
      if (warmTimer) clearInterval(warmTimer);
      // Flush every engine so trailing audio finalizes instead of being lost
      // when the client stops sending (partial-only sessions otherwise end
      // with zero persisted segments).
      for (const [channel, engine] of sttEngines) {
        // Close AFTER flush completes — async engines (Moonshine) decode the
        // trailing utterance during flush; closing first kills their pipeline
        // and the final is lost.
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          engine.close?.();
        };
        try {
          engine.flush((r) => {
            try {
              if (r.isFinal && r.text.trim()) {
                const speaker = channel === "system" ? "interviewer" : channel === "mic" ? "user" : undefined;
                void handleFinal(r.text, r.confidence, r.startedAtMs, r.endedAtMs, engine.source, speaker, utteranceId(channel));
                log.info("flush final on disconnect", { sessionId: session!.id, channel, chars: r.text.length });
              } else {
                log.info("flush on disconnect produced no text", { sessionId: session!.id, channel });
              }
            } finally {
              finish();
            }
          });
          // Synchronous flushes (sherpa) fire the callback inline; async ones
          // (Moonshine) land later. Give in-flight decodes a grace window.
          setTimeout(finish, 15_000);
        } catch (e) {
          log.warn("flush on disconnect failed", { sessionId: session!.id, channel, error: String(e) });
          finish();
        }
      }
      log.info("realtime disconnected", { traceId, sessionId: session!.id });
    });

    socket.on("error", (err: unknown) => {
      log.warn("realtime socket error", { error: String(err), traceId });
    });
  });
}

