/**
 * Arena â€” AI-interviewer practice mode. The system interviews the user:
 * question generation â†’ answer evaluation (0-10 + strengthened answer) â†’
 * progressive follow-ups. Routes through the platform AI seam (BYOK router,
 * free rungs included); rounds persist on the InterviewSession record
 * (metadata_json.kind = "arena") so Review surfaces them like any session.
 */
import type { VerticalRegistration, VerticalServices } from "@app/agent-sdk";
import { interviewIntelligenceManifest } from "./manifest.js";
import { QUESTION_BANK, offlineFramework } from "./prompts.js";
import { questionTokens, cosineOf, matchStories, type StoryCandidate } from "./storyMatch.js";

/** Typed facade over the Prisma client (no Prisma import in verticals). */
interface ArenaDb {
  storyEntry: {
    create(args: { data: { id: string; workspaceId: string; sessionId?: string | null; question: string; answer: string; score?: number | null; embedding?: unknown } }): Promise<{ id: string }>;
    findMany(args: { where: { workspaceId: string }, orderBy: { createdAt: "desc" }, take?: number }): Promise<{ id: string; question: string; answer: string; score: number | null; createdAt: Date; embedding: unknown }[]>;
  };
}

/** Round state machine: fresh â†’ questioning â†’ evaluating â†’ follow_up â†’ done */
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

export const vertical: VerticalRegistration = {
  manifest: interviewIntelligenceManifest,
  registerRoutes(register, services) {
    const ai = services?.ai;
    const db = services?.db as ArenaDb | undefined;

    register.get("/question-bank", (_req, reply) => {
      reply.send({ items: QUESTION_BANK });
    });

    // â”€â”€ Arena: generate the next question â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        role ? `Candidate role: ${role}${seniority ? ` (${seniority})` : ""}` : "Candidate role: unknown â€” ask a broadly relevant interview question",
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

    // â”€â”€ Arena: evaluate an answer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        "Be honest â€” inflated scores ruin practice. A vague answer scores low even if polished.",
        "strengthened = the same content rewritten as a 9-10 answer, first person, speakable aloud, using the candidate's own facts. No preamble, no labels, no markdown.",
        "Output ONLY JSON: {\"score\": number, \"strengths\": string[], \"weaknesses\": string[], \"strengthened\": string}",
      ].join("\n");

      try {
        const out = await ai.ask({
          workspaceId,
          taskClass: "deep_analysis",
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Interview style: ${mode}\n\nQuestion: ${question}\n\nCandidate's spoken answer (may be a transcript â€” judge content, forgive transcription typos):\n${answer.slice(0, 6000)}` },
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

    // Framework-only rehearsal (existing, kept for offline use)
    register.post("/rehearsal/framework", (req, reply) => {
      const body = (req as { body?: { transcript?: string } }).body ?? {};
      const transcript = typeof body.transcript === "string" ? body.transcript : "";
      reply.send({ mode: "framework_only", framework: offlineFramework(transcript) });
    });
  },
};


export { interviewIntelligenceManifest };
