/**
 * Arena — AI-interviewer practice mode. The system interviews the user:
 * question generation → answer evaluation (0-10 + strengthened answer) →
 * progressive follow-ups. Routes through the platform AI seam (BYOK router,
 * free rungs included); rounds persist on the InterviewSession record
 * (metadata_json.kind = "arena") so Review surfaces them like any session.
 */
import type { VerticalRegistration, VerticalServices } from "@app/agent-sdk";
import { interviewIntelligenceManifest } from "./manifest.js";
import { QUESTION_BANK, offlineFramework } from "./prompts.js";
import { buildSheetMessages, offlineSheet, normalizeSheet, type QuestionSheet } from "./interviewerSheet.js";
import { buildTitleMessages, normalizeTitle, offlineTitle } from "./sessionTitle.js";
import { questionTokens, cosineOf, matchStories, type StoryCandidate } from "./storyMatch.js";
import { analyzeSession, metricVerdicts, type AnalyzedSegment } from "./analytics.js";

/** Typed facade over the Prisma client (no Prisma import in verticals). */
interface ArenaDb {
  storyEntry: {
    create(args: { data: { id: string; workspaceId: string; sessionId?: string | null; question: string; answer: string; score?: number | null; embedding?: unknown } }): Promise<{ id: string }>;
    findMany(args: { where: { workspaceId: string }, orderBy: { createdAt: "desc" }, take?: number }): Promise<{ id: string; question: string; answer: string; score: number | null; createdAt: Date; embedding: unknown }[]>;
  };
  interviewSession: {
    findMany(args: { where: { workspaceId: string }, orderBy: { startedAt: "desc" }, take?: number }): Promise<{ id: string; title: string | null; startedAt: Date | null }[]>;
  };
  transcriptSegment: {
    findMany(args: { where: { sessionId: string }, orderBy: { sequenceNo: "asc" } }): Promise<{ text: string; speaker: string | null; startedAtMs: bigint | number | null; endedAtMs: bigint | number | null }[]>;
    findManyRaw?: never;
  };
  sessionInsight: {
    findMany(args: { where: { sessionId: string }, orderBy: { createdAt: "asc" } }): Promise<{ type: string; contentJson: unknown }[]>;
    findFirst(args: { where: { sessionId: string; type: string } }): Promise<{ id: string } | null>;
    create(args: { data: { id: string; sessionId: string; type: string; sourceSegmentIds: string[]; contentJson: unknown } }): Promise<{ id: string }>;
  };
  sessionContext: {
    findMany(args: { where: { sessionId: string; kind?: string } }): Promise<{ id: string; kind: string; title: string | null; content: string }[]>;
  };
}

/** Round state machine: fresh → questioning → evaluating → follow_up → done */
export interface ArenaRound {
  index: number;
  question: string;
  /** Follow-up depth: 0 = main question, 1-2 = probes. */
  depth: number;
  answer?: string;
  score?: number; // 0-10
  strengths?: string[];
  weaknesses?: string[];
  strengthened?: string; // what a 10/10 answer sounds like
  status: "fresh" | "questioning" | "evaluating" | "follow_up" | "done";
}

export interface ArenaState {
  sessionId: string;
  rounds: ArenaRound[];
  questionCount: number; // configured main questions
  currentIndex: number;
  difficulty: "progressive" | "steady";
}

const MAX_DEPTH = 2;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Upsert the deterministic metrics as a session insight (type
 *  "speech_metrics") so they ride the standard export/PDF path. Best-effort:
 *  analytics must never fail a request because persistence hiccuped. */
async function persistMetricsInsight(
  db: ArenaDb,
  sessionId: string,
  metrics: ReturnType<typeof analyzeSession>,
  verdicts: ReturnType<typeof metricVerdicts>,
): Promise<void> {
  if (metrics.segmentCount === 0) return; // nothing spoken — nothing to record
  try {
    const existing = await db.sessionInsight.findFirst({ where: { sessionId, type: "speech_metrics" } });
    if (existing) return; // fresh enough — metrics only improve as finals commit
    await db.sessionInsight.create({
      data: {
        id: crypto.randomUUID(),
        sessionId,
        type: "speech_metrics",
        sourceSegmentIds: [],
        contentJson: { metrics, verdicts },
      },
    });
  } catch { /* best-effort */ }
}

export const vertical: VerticalRegistration = {
  manifest: interviewIntelligenceManifest,
  registerRoutes(register, services) {
    const ai = services?.ai;
    const db = services?.db as ArenaDb | undefined;

    register.get("/question-bank", (_req, reply) => {
      reply.send({ items: QUESTION_BANK });
    });

    // ── Arena: generate the next question ────────────────────────────────
    // Input: { workspaceId, mode, role, seniority, previousQuestions[] }
    register.post("/arena/question", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const mode = str(body.mode) || "general";
      const role = str(body.role);
      const seniority = str(body.seniority);
      const previous = Array.isArray(body.previousQuestions) ? (body.previousQuestions as string[]).filter((q) => typeof q === "string") : [];
      const depth = Math.max(0, Math.min(MAX_DEPTH, Number(body.depth ?? 0)));
      const parentQuestion = str(body.parentQuestion);
      const userAnswer = str(body.userAnswer);

      if (!ai) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });
      }

      const system = [
        "You are a realistic technical interviewer conducting a live practice interview.",
        depth === 0
          ? "Ask ONE interview question appropriate for the role. Never repeat a previous question. Keep it natural and spoken-style (like it would be said aloud)."
          : `Ask ONE follow-up probe to the candidate's answer. ${depth === 1 ? "Push for specifics: a concrete example, a metric, or the tradeoff." : "Press on the weakest part of their answer or the hardest edge case."} Reference their answer directly.`,
        "Output ONLY JSON: {\"question\": string}",
      ].join("\n");

      const context = [
        role ? `Candidate role: ${role}${seniority ? ` (${seniority})` : ""}` : "Candidate role: unknown — ask a broadly relevant interview question",
        `Interview style: ${mode}`,
        previous.length > 0 ? `Questions already asked (do NOT repeat): ${previous.slice(-6).join(" | ")}` : "",
        depth > 0 ? `Main question: ${parentQuestion}\nCandidate's answer: ${userAnswer}` : "",
      ].filter(Boolean).join("\n");

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "live_coach",
          messages: [
            { role: "system", content: system },
            { role: "user", content: context },
          ],
          responseSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        });
        let question = str((out.structured as { question?: string } | null)?.question);
        if (!question && out.text) {
          try { question = str((JSON.parse(out.text) as { question?: string }).question); } catch { /* fallthrough */ }
        }
        if (!question) throw new Error("empty question from model");
        reply.send({ question: question.slice(0, 400), depth });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "arena_question_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Arena: evaluate an answer ─────────────────────────────────────────
    register.post("/arena/evaluate", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const question = str(body.question);
      const answer = str(body.answer);
      const mode = str(body.mode) || "general";

      if (!answer.trim()) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "answer required" });
      if (!ai) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });
      }

      const system = [
        "You are a strict but fair interview coach scoring a practice answer.",
        "Score 0-10: 9-10 exceptional (concrete STAR, metrics, owns the narrative); 7-8 strong (clear structure, one proof point); 5-6 adequate (generic, light on specifics); 3-4 weak (rambles, no example); 0-2 non-answer.",
        "Be honest — inflated scores ruin practice. A vague answer scores low even if polished.",
        "strengthened = the same content rewritten as a 9-10 answer, first person, speakable aloud, using the candidate's own facts. No preamble, no labels, no markdown.",
        "Output ONLY JSON: {\"score\": number, \"strengths\": string[], \"weaknesses\": string[], \"strengthened\": string}",
      ].join("\n");

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "deep_analysis",
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Interview style: ${mode}\n\nQuestion: ${question}\n\nCandidate's spoken answer (may be a transcript — judge content, forgive transcription typos):\n${answer.slice(0, 6000)}` },
          ],
          responseSchema: {
            type: "object",
            properties: {
              score: { type: "number" },
              strengths: { type: "array", items: { type: "string" } },
              weaknesses: { type: "array", items: { type: "string" } },
              strengthened: { type: "string" },
            },
            required: ["score", "strengths", "weaknesses", "strengthened"],
          },
        });
        let parsed: { score?: number; strengths?: string[]; weaknesses?: string[]; strengthened?: string } | undefined = undefined;
        if (out.structured) parsed = out.structured as { score?: number; strengths?: string[]; weaknesses?: string[]; strengthened?: string };
        else if (out.text) { try { parsed = JSON.parse(out.text) as { score?: number; strengths?: string[]; weaknesses?: string[]; strengthened?: string }; } catch { /* fallthrough */ } }
        if (!parsed || typeof parsed.score !== "number") throw new Error("unparseable evaluation");

        const score = Math.max(0, Math.min(10, Math.round(parsed.score)));
        const strengthened = str(parsed.strengthened).slice(0, 1200);

        // Story Bank: archive every scored answer so future sessions recall it.
        if (db && workspaceId) {
          try {
            await db.storyEntry.create({
              data: {
                id: crypto.randomUUID(),
                workspaceId,
                sessionId: str(body.sessionId) || null,
                question,
                answer: answer.slice(0, 8000),
                score,
                embedding: questionTokens(`${question} ${answer}`),
              },
            });
          } catch { /* story archive is best-effort */ }
        }

        reply.send({
          score,
          strengths: (parsed.strengths ?? []).slice(0, 3).map((s: string) => String(s).slice(0, 200)),
          weaknesses: (parsed.weaknesses ?? []).slice(0, 3).map((s: string) => String(s).slice(0, 200)),
          strengthened,
          providerId: out.providerId,
        });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "arena_evaluate_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Arena: predicted question bank from role/JD signals ─────────────
    // The "question horizon": what this interviewer will most likely ask.
    // Output feeds Arena drills directly — each predicted question can be
    // practiced immediately, and answers seed the live answer cache.
    register.post("/arena/predict", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const role = str(body.role);
      const seniority = str(body.seniority);
      const jd = str(body.jd).slice(0, 6000);
      const count = Math.max(5, Math.min(15, Number(body.count ?? 10)));

      if (!role && !jd) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "role or jd required" });
      }
      if (!ai) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });
      }

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "deep_analysis",
          messages: [
            {
              role: "system",
              content: [
                "You predict the questions a candidate will face in an interview for this role.",
                "Mix: 2-3 intro/behavioral, 3-5 role-specific technical or domain, 2-3 scenario/pressure probes.",
                "Questions must be spoken-style (as an interviewer would say them aloud), specific to the JD when one is given.",
                "Output ONLY JSON: {\"questions\": string[]} — exactly " + count + " questions, no numbering, no duplicates.",
              ].join(" "),
            },
            {
              role: "user",
              content: [
                role ? `Role: ${role}${seniority ? ` (${seniority})` : ""}` : "",
                jd ? `Job description:\n${jd}` : "",
              ].filter(Boolean).join("\n\n"),
            },
          ],
          responseSchema: { type: "object", properties: { questions: { type: "array", items: { type: "string" } } }, required: ["questions"] },
        });
        let questions: string[] = [];
        const raw = (out.structured as { questions?: unknown } | null)?.questions ?? (out.text ? (() => { try { return (JSON.parse(out.text) as { questions?: unknown }).questions; } catch { return undefined; } })() : undefined);
        if (Array.isArray(raw)) questions = raw.map((q) => String(q).slice(0, 300)).filter((q) => q.length > 8);
        if (questions.length === 0) throw new Error("empty prediction");
        reply.send({ questions: questions.slice(0, count), generatedFor: { role, seniority, jdChars: jd.length } });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "arena_predict_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Speech analytics: fillers, pace, verbosity, STAR trend ───────────
    // Deterministic (no LLM) — computed over persisted user-side finals.
    register.post("/arena/analytics", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      if (!workspaceId) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "workspaceId required" });
      if (!db) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "db_unavailable" });
      try {
        const sessions = await db.interviewSession.findMany({ where: { workspaceId }, orderBy: { startedAt: "desc" }, take: 10 });
        const trend: { sessionId: string; title: string | null; startedAt: string | null; metrics: ReturnType<typeof analyzeSession>; verdicts: ReturnType<typeof metricVerdicts> }[] = [];
        for (const s of sessions) {
          const segs = await db.transcriptSegment.findMany({ where: { sessionId: s.id }, orderBy: { sequenceNo: "asc" } });
          const analyzed: AnalyzedSegment[] = segs.map((t) => ({
            text: t.text,
            speaker: t.speaker,
            startedAtMs: t.startedAtMs == null ? null : Number(t.startedAtMs),
            endedAtMs: t.endedAtMs == null ? null : Number(t.endedAtMs),
          }));
          const metrics = analyzeSession(analyzed);
          const verdicts = metricVerdicts(metrics);
          trend.push({
            sessionId: s.id,
            title: s.title,
            startedAt: s.startedAt?.toISOString?.() ?? null,
            metrics,
            verdicts,
          });
          await persistMetricsInsight(db, s.id, metrics, verdicts);
        }
        reply.send({ trend: trend.reverse() }); // oldest → newest for chart order
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "analytics_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Follow-up generator: thank-you email + debrief from the transcript ──
    register.post("/arena/followup", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const sessionId = str(body.sessionId);
      if (!workspaceId || !sessionId) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "workspaceId and sessionId required" });
      if (!ai) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });
      if (!db) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "db_unavailable" });

      try {
        const segs = await db.transcriptSegment.findMany({ where: { sessionId }, orderBy: { sequenceNo: "asc" } });
        const transcript = segs.map((s) => `${s.speaker === "user" ? "You" : s.speaker === "interviewer" ? "Interviewer" : "?"}: ${s.text}`).join("\n").slice(-8000);
        if (!transcript.trim()) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "session has no transcript yet" });
        const insights = await db.sessionInsight.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
        const metrics = analyzeSession(segs.map((t) => ({
          text: t.text,
          speaker: t.speaker,
          startedAtMs: t.startedAtMs == null ? null : Number(t.startedAtMs),
          endedAtMs: t.endedAtMs == null ? null : Number(t.endedAtMs),
        })));
        const metricHint = [
          `Filler rate: ${metrics.fillerRate}/100 words.`,
          `Speaking pace: ${metrics.wpm == null ? "untimed" : `${metrics.wpm} wpm`}.`,
          `STAR-structured answers: ${Math.round(metrics.starShare * 100)}%.`,
          `Words per answer: ${metrics.verbosity}.`,
        ].join(" ");
        await persistMetricsInsight(db, sessionId, metrics, metricVerdicts(metrics));

        const out = await ai.ask({
          workspaceId,
          taskClass: "deep_analysis",
          messages: [
            {
              role: "system",
              content: [
                "You write post-interview follow-ups. Two parts, output ONLY JSON:",
                '1. {"subject": string, "email": string} — a thank-you email from the CANDIDATE to the interviewer. Reference 1-2 SPECIFIC moments from the actual transcript (a question they were asked, a project discussed). 120-180 words, warm, zero AI tells, no bullet lists.',
                '2. {"whatWentWell": string[], "toDrill": string[]} — honest debrief: 2-3 genuine strengths visible in the transcript, 2-3 concrete things to practice (reference Arena-style skills: STAR structure, metrics, pacing).',
              ].join("\n"),
            },
            { role: "user", content: `${transcript}\n\nMeasured speech metrics (ground the debrief in these numbers where relevant):\n${metricHint}` },
          ],
          responseSchema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              email: { type: "string" },
              whatWentWell: { type: "array", items: { type: "string" } },
              toDrill: { type: "array", items: { type: "string" } },
            },
            required: ["subject", "email", "whatWentWell", "toDrill"],
          },
        });
        let parsed: { subject?: string; email?: string; whatWentWell?: string[]; toDrill?: string[] } | undefined;
        if (out.structured) parsed = out.structured as typeof parsed;
        else if (out.text) { try { parsed = JSON.parse(out.text) as typeof parsed; } catch { /* fallthrough */ } }
        if (!parsed?.email) throw new Error("unparseable follow-up");
        reply.send({
          subject: str(parsed.subject).slice(0, 160) || "Great connecting today",
          email: parsed.email.slice(0, 4000),
          whatWentWell: (parsed.whatWentWell ?? []).slice(0, 4).map((s: string) => String(s).slice(0, 240)),
          toDrill: (parsed.toDrill ?? []).slice(0, 4).map((s: string) => String(s).slice(0, 240)),
          metrics,
          insightCount: insights.length,
        });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "followup_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Company Intelligence Pack: what will they ask, what should you know ──
    register.post("/arena/company-research", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const company = str(body.company);
      const role = str(body.role);
      const jd = str(body.jd).slice(0, 5000);
      if (!company.trim()) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "company required" });
      if (!ai) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "deep_analysis",
          messages: [
            {
              role: "system",
              content: [
                "You prepare a candidate for an interview at a specific company. From your knowledge of the company and industry:",
                "- overview: 2-3 sentences on what the company does and where it's heading",
                "- focusAreas: 3-4 products/technologies/business priorities likely to come up",
                "- likelyThemes: 3-4 interview themes this company is known for or that this role will attract",
                "- questionsToAsk: 3 smart questions the CANDIDATE should ask the interviewer (impressive, not generic)",
                "- watchouts: 1-3 honest cautions (known controversies, hard culture notes, technical gotchas)",
                "Be specific and factual from training knowledge; where unsure, mark with 'verify'. No markdown, plain strings.",
                "Output ONLY JSON with exactly those five keys.",
              ].join("\n"),
            },
            {
              role: "user",
              content: [
                `Company: ${company}`,
                role ? `Role: ${role}` : "",
                jd ? `Job description:\n${jd}` : "",
              ].filter(Boolean).join("\n\n"),
            },
          ],
          responseSchema: {
            type: "object",
            properties: {
              overview: { type: "string" },
              focusAreas: { type: "array", items: { type: "string" } },
              likelyThemes: { type: "array", items: { type: "string" } },
              questionsToAsk: { type: "array", items: { type: "string" } },
              watchouts: { type: "array", items: { type: "string" } },
            },
            required: ["overview", "focusAreas", "likelyThemes", "questionsToAsk", "watchouts"],
          },
        });
        let parsed: { overview?: string; focusAreas?: string[]; likelyThemes?: string[]; questionsToAsk?: string[]; watchouts?: string[] } | undefined;
        if (out.structured) parsed = out.structured as typeof parsed;
        else if (out.text) { try { parsed = JSON.parse(out.text) as typeof parsed; } catch { /* fallthrough */ } }
        if (!parsed?.overview) throw new Error("unparseable company pack");
        reply.send({
          overview: str(parsed.overview).slice(0, 900),
          focusAreas: (parsed.focusAreas ?? []).slice(0, 4),
          likelyThemes: (parsed.likelyThemes ?? []).slice(0, 4),
          questionsToAsk: (parsed.questionsToAsk ?? []).slice(0, 4),
          watchouts: (parsed.watchouts ?? []).slice(0, 3),
          providerId: out.providerId,
        });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "company_research_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Story Bank recall: "you answered this before" across sessions ────
    register.post("/arena/story-recall", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const question = str(body.question);
      if (!workspaceId || !question.trim()) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "workspaceId and question required" });
      }
      if (!db) return reply.send({ stories: [] });
      try {
        const rows = await db.storyEntry.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 300 });
        const candidates: StoryCandidate[] = rows.map((r) => ({
          id: r.id,
          question: r.question,
          answer: r.answer,
          score: r.score,
          embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : [],
        }));
        reply.send({ stories: matchStories(question, candidates) });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "story_recall_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Interviewer mode: question sheet from the session's cv + jd contexts ──
    // Reuses the platform's session-context pipeline (server-side pdf/docx/
    // xlsx extraction) — the vertical only reads the extracted text.
    register.post("/interviewer/sheet", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const sessionId = str(body.sessionId);
      const count = Math.max(5, Math.min(12, Number(body.count ?? 8)));
      if (!workspaceId || !sessionId) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "workspaceId and sessionId required" });
      if (!db) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "db_unavailable" });

      try {
        const contexts = await db.sessionContext.findMany({ where: { sessionId } });
        const jd = contexts.filter((c) => c.kind === "jd").map((c) => c.content).join("\n\n").slice(0, 6000);
        const cv = contexts.filter((c) => c.kind === "cv").map((c) => c.content).join("\n\n").slice(0, 8000);

        let sheet: QuestionSheet | null = null;
        let generatedBy: "llm" | "offline" = "offline";
        if (ai && (cv.trim() || jd.trim())) {
          try {
            const out = await ai.ask({
              workspaceId,
              taskClass: "deep_analysis",
              messages: buildSheetMessages(cv, jd, count),
              responseSchema: {
                type: "object",
                properties: {
                  questions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        question: { type: "string" },
                        intent: { type: "string" },
                        whatGoodLooksLike: { type: "string" },
                        probes: { type: "array", items: { type: "string" } },
                        difficulty: { type: "string", enum: ["warmup", "core", "pressure"] },
                      },
                      required: ["question", "intent", "whatGoodLooksLike", "probes", "difficulty"],
                    },
                  },
                },
                required: ["questions"],
              },
            });
            const raw = out.structured ?? (out.text ? (() => { try { return JSON.parse(out.text); } catch { return undefined; } })() : undefined);
            sheet = normalizeSheet(raw);
            if (sheet) generatedBy = "llm";
          } catch { /* fall through to the offline sheet */ }
        }
        if (!sheet) sheet = offlineSheet(cv, jd);

        // Persist the first sheet for this session so Review surfaces it.
        try {
          const existing = await db.sessionInsight.findFirst({ where: { sessionId, type: "question_sheet" } });
          if (!existing) {
            await db.sessionInsight.create({
              data: {
                id: crypto.randomUUID(),
                sessionId,
                type: "question_sheet",
                sourceSegmentIds: [],
                contentJson: { ...sheet, generatedBy, generatedAt: new Date().toISOString() },
              },
            });
          }
        } catch { /* best-effort */ }

        reply.send({ sheet, generatedBy, hasContexts: Boolean(cv.trim() || jd.trim()) });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "sheet_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Interviewer mode: live next-probe suggestions ────────────────────
    register.post("/interviewer/probe", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const question = str(body.question);
      const answerSoFar = str(body.answerSoFar);
      if (!question.trim()) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "question required" });
      if (!ai) {
        return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "no_provider", hint: "connect a provider in Settings (BYOK)" });
      }

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "live_coach",
          messages: [
            {
              role: "system",
              content: [
                "You whisper in an interviewer's ear in real time.",
                "The candidate just answered (or started answering) a question. Suggest 2-3 short follow-up probes to dig past a rehearsed answer — specifics, metrics, tradeoffs, or the hardest edge case.",
                "Also judge the answer so far: signal = \"strong\" (concrete, owned, evidenced), \"shallow\" (generic, buzzwords), or \"off_track\" (did not answer the question).",
                "Probes must be askable ALOUD, under 25 words each.",
                "Output ONLY JSON: {\"probes\": string[], \"signal\": \"strong\"|\"shallow\"|\"off_track\"}",
              ].join("\n"),
            },
            { role: "user", content: `Question asked:\n${question.slice(0, 600)}\n\nCandidate's answer so far (transcript — forgive typos):\n${answerSoFar.slice(0, 4000) || "(nothing yet)"}` },
          ],
          responseSchema: {
            type: "object",
            properties: {
              probes: { type: "array", items: { type: "string" } },
              signal: { type: "string", enum: ["strong", "shallow", "off_track"] },
            },
            required: ["probes", "signal"],
          },
        });
        let parsed: { probes?: unknown; signal?: unknown } | undefined;
        if (out.structured) parsed = out.structured as typeof parsed;
        else if (out.text) { try { parsed = JSON.parse(out.text) as typeof parsed; } catch { /* fallthrough */ } }
        const probes = Array.isArray(parsed?.probes)
          ? (parsed!.probes as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 3).slice(0, 3).map((p) => p.slice(0, 200))
          : [];
        const signal = parsed?.signal === "strong" || parsed?.signal === "shallow" || parsed?.signal === "off_track" ? parsed.signal : "shallow";
        reply.send({ probes, signal, providerId: out.providerId });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "probe_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── Session auto-naming: one model-generated title from CV/JD + opening
    // transcript. The caller PATCHes it through the platform session route;
    // the vertical never writes the session row itself.
    register.post("/session/suggest-title", async (req, reply) => {
      const body = (req as { body?: Record<string, unknown> }).body ?? {};
      const workspaceId = str(body.workspaceId);
      const sessionId = str(body.sessionId);
      if (!workspaceId || !sessionId) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "workspaceId and sessionId required" });
      if (!db) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(503).send({ error: "db_unavailable" });

      try {
        const contexts = await db.sessionContext.findMany({ where: { sessionId } });
        const cvs = contexts.filter((c) => c.kind === "cv");
        const jds = contexts.filter((c) => c.kind === "jd");
        const cv = cvs.map((c) => c.content).join("\n\n");
        const jd = jds.map((c) => c.content).join("\n\n");
        const segs = await db.transcriptSegment.findMany({ where: { sessionId }, orderBy: { sequenceNo: "asc" } });
        const transcript = segs.slice(-8).map((s) => s.text).join("\n");
        if (!cv.trim() && !jd.trim() && !transcript.trim()) {
          return (reply as { status(n: number): { send(v: unknown): unknown } }).status(400).send({ error: "nothing to name from yet — add CV/JD or start talking" });
        }

        let title = "";
        let generatedBy: "llm" | "offline" = "offline";
        if (ai) {
          try {
            const out = await ai.ask({
              workspaceId,
              taskClass: "deep_analysis",
              messages: buildTitleMessages(cv, jd, transcript),
              responseSchema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            });
            const raw = out.structured ?? (out.text ? (() => { try { return JSON.parse(out.text); } catch { return undefined; } })() : undefined);
            title = normalizeTitle((raw as { title?: unknown } | null)?.title);
            if (title) generatedBy = "llm";
          } catch { /* fall through to the offline title */ }
        }
        if (!title) {
          title = offlineTitle(
            cvs.map((c) => c.title ?? "").join(" "),
            jds.map((c) => c.title ?? "").join(" "),
            transcript,
          );
        }
        if (!title) return (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "title_failed" });
        reply.send({ title, generatedBy });
      } catch (e) {
        (reply as { status(n: number): { send(v: unknown): unknown } }).status(502).send({ error: "title_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    });

    // Framework-only rehearsal (existing, kept for offline use)
    register.post("/rehearsal/framework", (req, reply) => {
      const body = (req as { body?: { transcript?: string } }).body ?? {};
      const transcript = typeof body.transcript === "string" ? body.transcript : "";
      reply.send({ mode: "framework_only", framework: offlineFramework(transcript) });
    });
  },
};


export { interviewIntelligenceManifest };
