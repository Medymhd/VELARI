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
  classifyUtterance,
  matchPreparedQa,
  type CoachFramework,
} from "@app/vertical-interview-intelligence";
import { captureStyleProfile, withStyle, type StyleProfile, createEmbeddingProvider } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";
import { AnswerCache, prepHashOf, questionTokens, keyHashFor, normalizeQuestion } from "../services/answerCache.js";

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

    // REOPEN RESUME — a reopened session must never restart its sequence
    // numbering at 0: transcript_segments carries a UNIQUE (session_id,
    // sequence_no, is_final) index, and yesterday's rows already occupy 0..N.
    // Every new final would collide and fail to persist SILENTLY (the UI
    // still streams live via WS, so it looks like transcription works while
    // nothing saves — then everything is gone on reload). Resume the
    // assembler from the DB tail instead: numbering continues at max+1 AND
    // the coach's verbatim window opens with the prior conversation context.
    const assembler = newAssemblerState();
    try {
      const tail = await db.transcriptSegment.findMany({
        where: { sessionId: session!.id },
        orderBy: { sequenceNo: "desc" },
        take: 10,
      });
      for (const s of tail.reverse()) {
        try {
          ingestSegment(
            assembler,
            {
              id: s.id,
              sessionId: s.sessionId,
              sequenceNo: s.sequenceNo,
              startedAtMs: s.startedAtMs,
              endedAtMs: s.endedAtMs,
              text: s.text,
              confidence: s.confidence ?? 0.9,
              isFinal: true,
              source: s.source,
              ...(s.speaker ? { speaker: s.speaker as "user" | "interviewer" } : {}),
              createdAt: s.createdAt.toISOString(),
            } as never,
            `db:${s.id}`,
          );
        } catch { /* skip malformed row */ }
      }
      if (tail.length > 0) {
        log.info("reopened session resumed from transcript", {
          sessionId: session!.id,
          resumedSegments: tail.length,
          nextSequenceNo: assembler.nextSequenceNo,
        });
      }
    } catch (e) {
      log.warn("reopen resume failed (fresh sequence numbering)", { error: String(e) });
    }

    let serverSeq = 0;
    const seenClientIds = new Set<string>();
    // Dedup window is bounded: every audio.chunk carries an eventId (≈50/s),
    // so an unbounded Set leaks ~180k strings/hour on long sessions. Replays
    // only ever arrive seconds apart — 600 ids of recency is plenty.
    const SEEN_CLIENT_IDS_MAX = 600;
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
    const channelAudio = new Map<string, { lastPartialAt: number; lastFinalAt: number; lastChunkAtMs: number }>();
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
    // Lookup memo: a final can consult the cache up to three times (pre-gate,
    // runCoach, manual fast path) — with an external embedder each miss costs
    // a network round-trip. Same text+key within 10s reuses the verdict.
    let lastLookup: { key: string; at: number; hit: Awaited<ReturnType<AnswerCache["lookup"]>> } | null = null;
    async function cachedLookup(text: string, opts: { mode: string; length: string; prepHash: string }) {
      const key = `${normalizeQuestion(text)}|${opts.mode}|${opts.length}|${opts.prepHash}`;
      if (lastLookup && lastLookup.key === key && Date.now() - lastLookup.at < 10_000) return lastLookup.hit;
      const hit = await answerCache.lookup(text, opts);
      lastLookup = { key, at: Date.now(), hit };
      return hit;
    }
    let activePrepHash = "";
    try {
      const rows = await db.answerCacheEntry.findMany({
        where: { workspaceId: session!.workspaceId },
        orderBy: { createdAt: "asc" },
        take: 2000, // full session-memory cap: entries are ~KB, 2000 ≈ a few MB
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

    /** Endpoint watchdog — turns "partial stuck at 70%" into fast finals.
     *
     *  1. Chunk starvation (~1.2s): WASAPI loopback delivers NO packets
     *     during silence, so after the interviewer stops talking no
     *     audio.chunk reaches the engine — its feed()-based endpointing
     *     (800ms quiet tail) never gets a chunk to run on, and the partial
     *     hangs until the 10s stale flush. Flush as soon as the stream goes
     *     quiet with a partial outstanding: same semantics as endpointing,
      *     just enforced where the time information lives.
      *  2. Wedged decoder (10s): audio still flowing but no final — engine
      *     stall, force-finalize as before.
      *
      *  NOTE: the interval is STARTED at the end of the connection setup —
      *  created this early, its first 1s tick fired during the
      *  loadWorkspaceAiConfig await, before coachBusy/draftInFlight were
      *  initialized (TDZ ReferenceError → process death). */
    const startStaleWatchdog = (): ReturnType<typeof setInterval> => {
      const tick = () => {
        const now = Date.now();
        // Coach watchdog: a hung await inside runCoach (DB wedge, provider
        // freeze past the fetch deadline) must never wedge the pipeline
        // forever — coachBusy stuck true silently kills the coach AND the
        // cache lookups that live inside it. Force-release after 45s; the
        // next final re-arms everything naturally.
        if (coachBusy && coachBusySince > 0 && now - coachBusySince > 45_000) {
          log.warn("coach stuck >45s — force-releasing pipeline lock", { sessionId: session!.id, stuckMs: now - coachBusySince });
          coachBusy = false;
          coachBusySince = 0;
          draftInFlight = false;
        }
        for (const [channel, rec] of channelAudio) {
          if (rec.lastPartialAt <= rec.lastFinalAt) continue;
          const sinceChunk = now - rec.lastChunkAtMs;
          const sincePartial = now - rec.lastPartialAt;
          // Starvation: no chunk for 1.2s with a partial outstanding — the
          // engine can't endpoint without chunks, flush now. (After the flush
          // lastFinalAt > lastPartialAt, so this fires once per utterance.)
          // Wedged: chunks still flowing but no final for 10s.
          const starving = rec.lastChunkAtMs > 0 && sinceChunk > 1_200;
          if (!starving && sincePartial <= 10_000) continue;
          rec.lastFinalAt = now; // reset before flush to avoid re-trigger loops
          const engine = sttEngines.get(channel);
          if (engine) {
            log.info(
              starving ? "endpoint flush (chunk starvation)" : "stale partial — forcing flush",
              { sessionId: session!.id, channel, sincePartialMs: sincePartial, sinceChunkMs: sinceChunk },
            );
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
      };
      return setInterval(tick, 1_000);
    };
    let staleTimer: ReturnType<typeof setInterval> | null = null;

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

      // Session memory — fully warm from the first millisecond of a (re)opened
      // session:
      //   1. prepHash pinned now so every cache path agrees on the key.
      //   2. Session-self hydration: this session's own past answers seed the
      //      in-memory cache (drafts are NOT in the workspace cache rows —
      //      see the draft seeding — so a reopened session would otherwise
      //      start cold for exactly the questions it already answered).
      //   3. Embedding backfill: entries seeded while the embedder was down
      //      have empty vectors; backfill once in the background and persist,
      //      so the vector tier serves them forever after.
      activePrepHash = prepHashOf(prepContext, qaBank);
      try {
        const own = await db.sessionInsight.findMany({
          where: { sessionId: session!.id, type: { in: ["suggested_answer", "auto_answer"] } },
          orderBy: { createdAt: "asc" },
        });
        let hydrated = 0;
        for (const ins of own) {
          const cj = (ins.contentJson ?? {}) as Record<string, unknown>;
          const q = String(cj.detected_question ?? cj.question ?? "").trim();
          const answerText = Array.isArray(cj.talking_points)
            ? (cj.talking_points as unknown[]).map(String).join(" ")
            : String(cj.answer ?? "");
          if (q.length < 8 || !answerText || answerCache.hasQuestion(q, sessionMode, sessionLength, activePrepHash)) continue;
          answerCache.seed({
            id: ins.id,
            question: q,
            tokens: questionTokens(q),
            embedding: [],
            frameworkJson: cj,
            answerText,
            mode: sessionMode,
            length: sessionLength,
            prepHash: activePrepHash,
          });
          hydrated += 1;
        }
        if (hydrated > 0) log.info("session memory hydrated", { sessionId: session!.id, entries: hydrated });
      } catch (e) {
        log.warn("session memory hydration skipped", { error: String(e) });
      }
      // Background vector backfill — never on the answer path.
      void (async () => {
        try {
          const missing = answerCache.missingEmbeddings();
          if (missing.length === 0) return;
          for (let i = 0; i < missing.length; i += 32) {
            const batch = missing.slice(i, i + 32);
            const vecs = await embedder.embed(batch.map((b) => b.question)).catch(() => [] as number[][]);
            for (let j = 0; j < batch.length; j++) {
              const vec = vecs[j];
              if (!vec || vec.length === 0) continue;
              answerCache.setEmbedding(batch[j]!.id, vec);
              await db.answerCacheEntry.update({ where: { id: batch[j]!.id }, data: { embeddingJson: vec } }).catch(() => {});
            }
          }
          log.info("cache embeddings backfilled", { sessionId: session!.id, count: missing.length });
        } catch { /* best-effort */ }
      })();
      // (Question radar kick moved to the END of the connection setup — the
      // TDZ crash: this line ran before the `let radarBusy`/`coachBusy`
      // declarations below had executed, killing the whole connection.)

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

    /** One-shot flag: transcript persist failures must surface to the UI. */
    let persistWarned = false;

    async function handleFinal(
      text: string,
      confidence: number,
      startedAtMs: number,
      endedAtMs: number,
      source: string,
      speaker?: "user" | "interviewer",
      segmentId?: string,
      /** Pre-resolved framework (cache hit) — emitted as-is instead of running
       *  the LLM coach. */
      cachedFramework?: Record<string, unknown>,
    ): Promise<void> {
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

      // Manual (typed overlay) asks count as interviewer-perspective for the
      // coach pipeline, but are NOT live interviewer audio — flipping
      // sawInterviewer would silence mic-driven coaching in speakerphone/
      // in-person sessions after the first typed question.
      if (speaker === "interviewer" && source !== "manual") sawInterviewer = true;

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
    // Silent transcript loss is the worst failure mode (the live panel keeps
    // streaming, so it LOOKS fine until reload). Surface it once loudly.
    if (!persistWarned) {
      persistWarned = true;
      emit({
        type: "pipeline.warning",
        eventId: randomUUID(),
        sequenceNo: serverSeq++,
        occurredAt: new Date().toISOString(),
        sessionId: session!.id,
        code: "persist_failed",
        message: "Transcript persistence failed — new speech will not be saved. Restart the session.",
      });
    }
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

      // Pre-resolved framework (cache fast path from coach.ask): emit as a
      // suggested_answer with cached chips and return — no LLM, and the
      // judge never gets a chance to swallow a manual ask as a duplicate.
      if (cachedFramework) {
        const insightId = randomUUID();
        const contentJson: Record<string, unknown> = { ...cachedFramework, stt_confidence: confidence };
        try {
          await db.sessionInsight.create({
            data: {
              id: insightId,
              sessionId: session!.id,
              type: "suggested_answer",
              sourceSegmentIds: [finalSegmentId],
              contentJson: contentJson as any,
              modelTraceId: traceId,
            },
          });
        } catch (e) {
          log.warn("failed to persist cached insight", { error: String(e) });
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
            sourceSegmentIds: [finalSegmentId],
            contentJson: contentJson as any,
            modelTraceId: traceId,
            createdAt: new Date().toISOString(),
          },
        });
        return;
      }

      // Rival semantic (Cluely/LockedIn parity): the coach responds to the
      // interviewer's speech (loopback). Channel-less (browser mic) finals
      // count as interviewer. Until interviewer audio exists at all, mic
      // speech drives coaching — the mic is the only conversation in a
      // speakerphone/in-person session. Once loopback interviewer audio
      // appears, mic speech stops coaching (it's the user's own voice).
      if (speaker !== "user" || !sawInterviewer) {
        // Utterance classification: real interviews are conversations —
        // questions, greetings, clarifications and statements. Backchannel
        // ("mm-hm", "okay") never wakes the coach; everything else does.
        const utteranceType = classifyUtterance(text);
        // CACHE/PREDICTED FIRST — when the answer is already known (asked
        // before, or radar pre-computed), serve it in ~0ms: no draft claim,
        // no coach call, no judge. Questions only — greetings and statements
        // are answered fresh every time, never cached.
        if (!preparedServed && utteranceType === "question" && answerCache.size() > 0) {
          const pHash = activePrepHash || (activePrepHash = prepHashOf(prepContext, qaBank));
          try {
            const hit = await cachedLookup(text, { mode: sessionMode, length: sessionLength, prepHash: pHash });
            if (hit && (hit.key === "exact" || hit.key === "fuzzy")) {
              log.info("cache-first hit", { sessionId: session!.id, tier: hit.key, score: hit.score });
              await db.answerCacheEntry.update({ where: { id: hit.id }, data: { hitCount: { increment: 1 } } }).catch(() => {});
              radarPreServes += hit.frameworkJson?.predicted === true ? 1 : 0;
              const insightId = randomUUID();
              const contentJson: Record<string, unknown> = {
                ...hit.frameworkJson,
                cached: true,
                cache_tier: hit.key,
                cache_score: hit.score,
                cached_question: hit.matchedQuestion,
                detected_question: text.slice(0, 300),
              };
              try {
                await db.sessionInsight.create({
                  data: {
                    id: insightId,
                    sessionId: session!.id,
                    type: "suggested_answer",
                    sourceSegmentIds: [finalSegmentId],
                    contentJson: contentJson as any,
                    modelTraceId: traceId,
                  },
                });
              } catch (e) {
                log.warn("failed to persist cache-first insight", { error: String(e) });
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
                  sourceSegmentIds: [finalSegmentId],
                  contentJson: contentJson as any,
                  modelTraceId: traceId,
                  createdAt: new Date().toISOString(),
                },
              });
              return;
            }
          } catch (e) {
            log.warn("cache-first lookup failed (continuing)", { error: String(e) });
          }
        }
        // Answer-first sequencing: a question-shaped final drafts the spoken
        // answer FIRST, then the framework coach runs after it settles. The
        // speakable answer lands after ONE LLM round-trip (instead of two
        // sequential ones), and there is never more than ONE concurrent call
        // — two concurrent calls trip free-tier 429s, which open breakers and
        // stall the whole pipeline (the regression this replaces). Skipped
        // entirely when the cache-first block above already served the answer.
        // Greetings/statements/clarifications go straight to the conversational
        // framework coach — no verbatim draft needed for them.
        if (utteranceType === "question" && !preparedServed && maybeClaimDraft(text)) {
          lastTriggerNorm = normalizeTrigger(text); // keep the coach gate in sync
          const tail = assembler.finals.slice(-6).map((s: { text: string }) => s.text).join("\n");
          const draft = draftAutoAnswer(text, tail.slice(-2000), utteranceType)
            .catch(() => {})
            .finally(() => { draftInFlight = false; });
          void Promise.race([draft, sleepMs(7_000)]).then(() => {
            if (coachBusy) scheduleCoaching(); // another framework is in flight — normal path
            else void runCoach(utteranceType);
          });
        } else {
          scheduleCoaching();
        }
      }
      // Radar re-arm: every final is a chance to refresh predictions (gates +
      // cadence enforced inside maybeRadar — this call is free when idle).
      void maybeRadar();
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
    /** When the current runCoach started — drives the stuck watchdog. */
    let coachBusySince = 0;

    /** Confirmation window: coaching fires only after the speaker has held
     *  still for this long. Every new final from the same conversation resets
     *  it, so a short mid-sentence pause never triggers a premature (wrong)
     *  answer. Wait-for-completion beats raw speed. */
    const COACH_CONFIRM_MS = 900;

    // ── Question radar ─────────────────────────────────────────────────
    // Predicts the NEXT likely interviewer questions and pre-computes their
    // answers into the cache, so a predicted follow-up is served in ~0ms the
    // moment it is actually asked. Strictly idle-window work: it fires only
    // when the coach AND draft are quiet (≥8s since the last provider call),
    // at most once per 3 minutes, as ONE batched LLM call — it never stacks
    // with coaching and never touches Moonshine (network-bound JSON only).
    const RADAR_MIN_INTERVAL_MS = 180_000;
    const RADAR_IDLE_MS = 8_000;
    let radarBusy = false;
    /** coach.solve in flight — the radar must not stack a second provider call. */
    let solveBusy = false;
    let lastRadarAt = 0;
    let radarPreServes = 0;

    async function maybeRadar(force = false): Promise<void> {
      if (!workspaceCfg || radarBusy) return;
      const now = Date.now();
      if (!force && now - lastRadarAt < RADAR_MIN_INTERVAL_MS) return;
      if (coachBusy || draftInFlight || solveBusy) return;
      if (now - lastCoachActivityAt < RADAR_IDLE_MS) return;
      radarBusy = true;
      lastRadarAt = now;
      try {
        const askedNorms = new Set(assembler.finals.map((s: { text: string }) => normalizeQuestion(s.text)));
        const outcome = await executeRouted(
          { db, breakers },
          workspaceCfg,
          session!.workspaceId,
          session!.id,
          {
            taskClass: "question_radar",
            privacyMode: workspaceCfg.privacyMode,
            maxTokens: 700,
            messages: [
              {
                role: "system",
                content:
                  "You are an interview radar. Given the role, the candidate's prep materials and the conversation so far, predict the THREE questions the interviewer is MOST likely to ask next (spoken style, as an interviewer would say them), and for each write the best possible candidate answer grounded in the prep materials. Never repeat a question already asked. Output ONLY JSON: {\"qa\":[{\"question\":string,\"answer\":string,\"talking_points\":string[]}]} — exactly 3 items.",
              },
              {
                role: "user",
                content: [
                  personaContext ?? "",
                  prepContext ? `Prep materials:\n${headParagraphs(prepContext, 4000)}` : "",
                  rollingSummary ? `Conversation so far (summary):\n${rollingSummary}` : "",
                  `Already asked (do NOT repeat):\n${assembler.finals.slice(-6).map((s: { text: string }) => `- ${s.text}`).join("\n")}`,
                ].filter(Boolean).join("\n\n"),
              },
            ],
            responseSchema: {
              type: "object",
              properties: {
                qa: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      question: { type: "string" },
                      answer: { type: "string" },
                      talking_points: { type: "array", items: { type: "string" } },
                    },
                    required: ["question", "answer", "talking_points"],
                  },
                },
              },
              required: ["qa"],
            },
          } as never,
        );
        if (!outcome.ok) return;
        let qa: Array<{ question?: unknown; answer?: unknown; talking_points?: unknown }> = [];
        const raw = (outcome.structured as { qa?: unknown } | null)?.qa
          ?? (() => { try { return (JSON.parse(outcome.text ?? "") as { qa?: unknown }).qa; } catch { return undefined; } })();
        if (Array.isArray(raw)) qa = raw as typeof qa;
        const pHash = activePrepHash || (activePrepHash = prepHashOf(prepContext, qaBank));
        let seeded = 0;
        const seededQs: string[] = [];
        for (const item of qa.slice(0, 3)) {
          const q = String(item.question ?? "").trim();
          const a = String(item.answer ?? "").trim();
          if (q.length < 12 || a.split(/\s+/).length < 6) continue;
          if (askedNorms.has(normalizeQuestion(q))) continue; // already asked
          if (answerCache.hasQuestion(q, sessionMode, sessionLength, pHash)) continue; // already cached
          const tokens = questionTokens(q);
          const [emb] = await embedder.embed([q]).catch(() => [[] as number[]]);
          const frameworkJson = {
            detected_question: q,
            suggested_outline: [],
            talking_points: Array.isArray(item.talking_points) ? (item.talking_points as unknown[]).map(String).slice(0, 4) : [a.slice(0, 160)],
            confidence: 0.75,
            predicted: true,
          };
          const entry = {
            id: randomUUID(),
            workspaceId: session!.workspaceId,
            keyHash: keyHashFor({ question: q, mode: sessionMode, length: sessionLength, prepHash: pHash }),
            question: q,
            tokensJson: tokens,
            embeddingJson: (emb ?? []) as unknown as Prisma.InputJsonValue,
            frameworkJson: frameworkJson as unknown as Prisma.InputJsonValue,
            answerText: a,
            mode: sessionMode,
            length: sessionLength,
            prepHash: pHash,
            hitCount: 0,
            sourceSessionId: session!.id,
          };
          try {
            await db.answerCacheEntry.upsert({
              where: { workspaceId_keyHash: { workspaceId: session!.workspaceId, keyHash: entry.keyHash } },
              create: entry,
              update: { frameworkJson: entry.frameworkJson, answerText: a, embeddingJson: entry.embeddingJson, tokensJson: entry.tokensJson },
            });
          } catch (e) {
            log.warn("radar cache upsert failed", { error: String(e) });
          }
          answerCache.seed({
            id: entry.id,
            question: q,
            tokens,
            embedding: emb ?? [],
            frameworkJson: frameworkJson as Record<string, unknown>,
            answerText: a,
            mode: sessionMode,
            length: sessionLength,
            prepHash: pHash,
          });
          seededQs.push(q);
          seeded += 1;
        }
        log.info("question radar refresh", { sessionId: session!.id, seeded, preServedSoFar: radarPreServes });
        // Surface the horizon on the stealth overlay ("Up next") — the client
        // forwards this to the overlay via the Rust emitter.
        if (seededQs.length > 0) {
          emit({
            type: "radar.predicted",
            eventId: randomUUID(),
            sequenceNo: serverSeq++,
            occurredAt: new Date().toISOString(),
            sessionId: session!.id,
            questions: seededQs.slice(0, 2),
          } as never);
        }
      } catch (e) {
        log.warn("question radar failed (non-fatal)", { error: String(e) });
        // Surface to the client — a dead radar is invisible otherwise.
        emit({
          type: "pipeline.warning",
          eventId: randomUUID(),
          sequenceNo: serverSeq++,
          occurredAt: new Date().toISOString(),
          sessionId: session!.id,
          code: "radar_failed",
          message: `Question radar failed: ${String(e).slice(0, 140)}`,
        });
      } finally {
        radarBusy = false;
      }
    }

    /** Junk-trigger gate state: the last normalized trigger text. */
    let lastTriggerNorm = "";

    /** Manual-ask duplicate-bypass — set by coach.ask around its runCoach
     *  invocation so the judge never swallows a typed question. */
    let bypassDuplicateFilter = false;

    /** Timestamp of the last heuristic verbatim draft. The coach's own draft
     *  trigger defers to it — one draft per question, whichever path fires
     *  first. */
    let lastParallelDraftAt = 0;

    function scheduleCoaching(utteranceType?: ReturnType<typeof classifyUtterance>): void {
      // Conversation gate: backchannel ("mm-hm", "okay", short fragments)
      // never coaches; greetings, clarifications, statements and questions
      // always do — a greeting is not junk and must be answered in kind.
      const latest = String(assembler.finals.at(-1)?.text ?? "").trim();
      const type = utteranceType ?? (latest ? classifyUtterance(latest) : "statement");
      if (type === "backchannel") return;
      if (latest) {
        const norm = latest.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
        // Consecutive identical triggers burn quota — except greetings, which
        // are answered fresh every time (a repeated hello is never a repeat).
        if (norm && norm === lastTriggerNorm && type !== "greeting") return;
        lastTriggerNorm = norm;
      }
      // Preempt immediately: whatever the coach is crafting is already stale —
      // the conversation moved on.
      coachAbort?.abort();
      coachAbort = null;
      if (coachTimer) clearTimeout(coachTimer);
      coachTimer = setTimeout(() => {
        void runCoach(type);
      }, COACH_CONFIRM_MS);
    }

    async function runCoach(utteranceType?: ReturnType<typeof classifyUtterance>): Promise<void> {
      if (!workspaceCfg) return;
      coachAbort?.abort();
      const abort = new AbortController();
      coachAbort = abort;
      const epoch = ++coachEpoch;
      coachBusy = true;
      coachBusySince = Date.now();
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
        utteranceType,
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
          const hit = await cachedLookup(lastQuestionLine, { mode: sessionMode, length: sessionLength, prepHash });
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
            maxTokens: 900,
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
                response: { type: "string" },
                confidence: { type: "number" },
                requires_user_review: { type: "boolean" },
              },
              required: ["detected_question", "suggested_outline", "talking_points", "response", "confidence", "requires_user_review"],
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
          // The conversational reply is the speakable answer — mapping it to
          // `answer` makes every downstream path work unchanged: overlay
          // answer cards, Live panel, speak-aloud, cache seeding.
          if (typeof contentJson.response === "string" && (contentJson.response as string).trim()) {
            contentJson.answer = (contentJson.response as string).trim();
          }

          // Auto-answer judge: filter weak/repetitive output before UI + persistence.
          // Manual asks (bypass) skip the duplicate gate — the user explicitly
          // typed this question; silence is the worst possible outcome.
          const bypassJudge = bypassDuplicateFilter;
          bypassDuplicateFilter = false;
          const verdict = bypassJudge
            ? { accept: true, reason: "manual_bypass" as string | undefined }
            : judgeSuggestion(judge, contentJson as unknown as CoachFramework, Date.now());
          if (!verdict.accept && !(verdict.reason === "duplicate_question" && bypassJudge)) {
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
          coachBusySince = 0;
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

    async function draftAutoAnswer(question: string, transcriptTail: string, utteranceType: ReturnType<typeof classifyUtterance> = "question"): Promise<void> {
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
              utteranceType,
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
        // Seed the cache with the spoken draft — these are the answers the
        // user actually reads aloud, yet only judge-accepted frameworks used
        // to seed. Re-asking (or a radar-adjacent paraphrase) must hit cache.
        try {
          const seedPrepHash = activePrepHash || (activePrepHash = prepHashOf(prepContext, qaBank));
          const seedTokens = questionTokens(question);
          const [emb] = await embedder.embed([question]).catch(() => [[] as number[]]);
          const seedFramework = { question, answer } as unknown as Prisma.InputJsonValue;
          const seedEntry = {
            id: randomUUID(),
            workspaceId: session!.workspaceId,
            keyHash: keyHashFor({ question, mode: sessionMode, length: sessionLength, prepHash: seedPrepHash }),
            question,
            tokensJson: seedTokens,
            embeddingJson: (emb ?? []) as unknown as Prisma.InputJsonValue,
            frameworkJson: seedFramework,
            answerText: answer,
            mode: sessionMode,
            length: sessionLength,
            prepHash: seedPrepHash,
            hitCount: 0,
            sourceSessionId: session!.id,
          };
          await db.answerCacheEntry.upsert({
            where: { workspaceId_keyHash: { workspaceId: session!.workspaceId, keyHash: seedEntry.keyHash } },
            create: seedEntry,
            update: { frameworkJson: seedFramework, answerText: answer, embeddingJson: seedEntry.embeddingJson, tokensJson: seedTokens },
          });
          answerCache.seed({
            id: seedEntry.id,
            question,
            tokens: seedTokens,
            embedding: emb ?? [],
            frameworkJson: { question, answer },
            answerText: answer,
            mode: sessionMode,
            length: sessionLength,
            prepHash: seedPrepHash,
          });
        } catch (e) {
          log.warn("draft cache seed failed (non-fatal)", { error: String(e) });
        }
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
      if ("eventId" in frame) {
        seenClientIds.add(frame.eventId);
        if (seenClientIds.size > SEEN_CLIENT_IDS_MAX) {
          // Sets iterate in insertion order — evict the oldest fifth.
          let evict = SEEN_CLIENT_IDS_MAX / 5;
          for (const id of seenClientIds) {
            seenClientIds.delete(id);
            if (--evict <= 0) break;
          }
        }
      }

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
        // Chunk recency — the endpoint watchdog keys off this to distinguish
        // "engine wedged" from "loopback delivered nothing to endpoint on".
        const rec0 = channelAudio.get(frame.channel ?? "default") ?? { lastPartialAt: 0, lastFinalAt: 0, lastChunkAtMs: 0 };
        rec0.lastChunkAtMs = nowMs;
        channelAudio.set(frame.channel ?? "default", rec0);
        engine.feed(pcm, nowMs, (result) => {
          // Defer socket writes out of the engine's synchronous decode loop —
          // sync sends from inside a native (napi) callback stack corrupt the
          // recognizer's decode state.
          queueMicrotask(() => {
            const rec = channelAudio.get(frame.channel ?? "default") ?? { lastPartialAt: 0, lastFinalAt: 0, lastChunkAtMs: 0 };
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

      if (frame.type === "coach.ask") {
        // Written ask from the stealth overlay: a typed/pasted question or a
        // direction for the coach. handleFinal exempts source "manual" from
        // the sawInterviewer flip — a typed ask is not live interviewer
        // audio, and flipping it would silence mic-driven coaching in
        // speakerphone/in-person sessions after the first typed question.
        const text = frame.text.trim();
        if (!text || !workspaceCfg) return;
        log.info("coach.ask received", { sessionId: session!.id, chars: text.length });

        // CACHE FAST PATH — check before handleFinal so a repeated question
        // is answered instantly and never risked to the duplicate filter.
        // (The verbatim path also checks, but its duplicate_question swallow
        // would silently drop a manual ask — unacceptable for typed input.)
        const askPrepHash = activePrepHash || (activePrepHash = prepHashOf(prepContext, qaBank));
        if (answerCache.size() > 0 && text.length > 12) {
          try {
            const hit = await cachedLookup(text, { mode: sessionMode, length: sessionLength, prepHash: askPrepHash });
            if (hit) {
              log.info("coach.ask cache hit", { sessionId: session!.id, tier: hit.key, score: hit.score });
              await db.answerCacheEntry.update({ where: { id: hit.id }, data: { hitCount: { increment: 1 } } }).catch(() => {});
              await handleFinal(text, 1.0, Date.now(), Date.now(), "manual", "interviewer", undefined, {
                cached: true,
                cache_tier: hit.key,
                cache_score: hit.score,
                cached_question: hit.matchedQuestion,
                detected_question: text.slice(0, 300),
                ...hit.frameworkJson,
              });
              return;
            }
          } catch (e) {
            log.warn("coach.ask cache lookup failed (continuing normal path)", { error: String(e) });
          }
        }

        // No cache hit — normal pipeline (persist segment, LLM coach).
        // The judge's duplicate_question filter must not swallow a manual
        // ask: arm the bypass so the next runCoach keeps the result.
        bypassDuplicateFilter = true;
        await handleFinal(text, 1.0, Date.now(), Date.now(), "manual", "interviewer");
        return;
      }

      if (frame.type === "coach.solve") {
        // Direct LLM prompt from the overlay "Solve" mode: evaluate, analyze,
        // compare, draft — answered AS-IS (no coach framing, no prep context,
        // no cache). The user pasted the full prompt; the model just solves.
        // Result lands as a `solver` insight rendered in the answer zone of
        // both the overlay and the Live session panel.
        const text = frame.text.trim();
        if (!text || !workspaceCfg) return;
        if (solveBusy) {
          // One solve at a time — two concurrent provider calls trip
          // free-tier 429s and open breakers for the whole pipeline.
          emit({
            type: "pipeline.warning",
            eventId: randomUUID(),
            sequenceNo: serverSeq++,
            occurredAt: new Date().toISOString(),
            sessionId: session!.id,
            code: "solver_busy",
            message: "A prompt is already running — wait for it to finish",
          });
          return;
        }
        log.info("coach.solve received", { sessionId: session!.id, chars: text.length });
        solveBusy = true;
        try {
          const outcome = await executeRouted(
            { db, breakers },
            workspaceCfg,
            session!.workspaceId,
            session!.id,
            {
              taskClass: "solver",
              privacyMode: workspaceCfg.privacyMode,
              maxLatencyMs: 60_000, // analyze/evaluate prompts run long
              messages: [
                {
                  role: "system",
                  content:
                    "You are a precise assistant embedded in a live interview copilot. The user sends tasks such as evaluate, analyze, compare, summarize, draft or solve. Answer directly and completely in plain text — short paragraphs or dash lists, no markdown headers. No preamble, no restating the task.",
                },
                { role: "user", content: text },
              ],
            } as never,
          );
          const answer = outcome.ok ? (outcome.text ?? "").trim() : "";
          const insightId = randomUUID();
          const contentJson: Record<string, unknown> = {
            question: text.slice(0, 500),
            answer,
            ...(outcome.ok ? {} : { offline: true, error: String(outcome.error ?? "LLM unavailable") }),
          };
          try {
            await db.sessionInsight.create({
              data: {
                id: insightId,
                sessionId: session!.id,
                type: "solver",
                sourceSegmentIds: [],
                contentJson: contentJson as any,
                modelTraceId: traceId,
              },
            });
          } catch (e) {
            log.warn("failed to persist solver result", { error: String(e) });
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
              type: "solver",
              sourceSegmentIds: [],
              contentJson: contentJson as any,
              modelTraceId: traceId,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (e) {
          log.warn("coach.solve failed", { error: String(e) });
        } finally {
          solveBusy = false;
        }
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

    // Timers start HERE — the very end of the connection setup, after every
    // `let` in the callback body has been initialized. (Created earlier, the
    // 1s watchdog tick fired during the loadWorkspaceAiConfig await — TDZ
    // ReferenceError → process death. Same class as the radar-kick crash.)
    staleTimer = startStaleWatchdog();

    // Question radar initial kick — same TDZ rule as above.
    void maybeRadar();
  });
}

