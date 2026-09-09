/**
 * Interviewer mode — question-sheet generation. The mirror of the candidate
 * coach: instead of coaching answers, it crafts the questions. Laddered
 * warmup → core → pressure, each with intent + what-good-looks-like so the
 * interviewer knows what "a good answer" sounds like before asking.
 */
import type { ChatMessage } from "@app/contracts";

export type SheetDifficulty = "warmup" | "core" | "pressure";

export interface SheetQuestion {
  question: string;
  /** What this question is testing — the interviewer's note-to-self. */
  intent: string;
  /** What a strong answer contains (evidence, ownership, metrics). */
  whatGoodLooksLike: string;
  /** 1-2 follow-up probes to dig past a rehearsed answer. */
  probes: string[];
  difficulty: SheetDifficulty;
}

export interface QuestionSheet {
  questions: SheetQuestion[];
}

export function buildSheetMessages(cv: string, jd: string, count: number): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You help an interviewer prepare for a specific candidate's interview.",
        "Produce a laddered question sheet from the CV and the job description:",
        "1-2 warmup questions (ease into the conversation, verify the obvious),",
        `${Math.ceil(count * 0.5)} core questions (the substance — probe the CV's biggest claims against the JD),`,
        `${Math.max(1, Math.floor(count * 0.3))} pressure questions (edge cases, tradeoffs, failure stories).`,
        "Each question needs: intent (what it tests), whatGoodLooksLike (what a strong answer contains), 1-2 probes to push past a rehearsed answer.",
        "Questions must be askable ALOUD, plain language, specific to THIS candidate's CV — never generic.",
        "Output ONLY JSON: {\"questions\": [{\"question\": string, \"intent\": string, \"whatGoodLooksLike\": string, \"probes\": string[], \"difficulty\": \"warmup\"|\"core\"|\"pressure\"}]}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        jd ? `Job description:\n${jd.slice(0, 6000)}` : "Job description: (not provided — infer a plausible role from the CV)",
        `Candidate CV:\n${cv.slice(0, 8000)}`,
        `Total questions: ${count}.`,
      ].join("\n\n"),
    },
  ];
}

/** Deterministic fallback — laddered from CV/JD keywords so the interviewer
 *  always has a working sheet even with no provider connected. */
export function offlineSheet(cv: string, jd: string): QuestionSheet {
  const corpus = `${jd}\n${cv}`;
  const keywords = Array.from(
    new Set(
      (corpus.match(/\b[A-Za-z][A-Za-z0-9+#.-]{3,}\b/g) ?? [])
        .filter((w) => !STOPWORDS.has(w.toLowerCase()))
        .map((w) => w.toLowerCase()),
    ),
  ).slice(0, 6);
  const claim = keywords[0] ?? "the project";
  const tool = keywords[1] ?? "your main tool";

  const questions: SheetQuestion[] = [
    {
      question: "Walk me through the project you're proudest on your CV.",
      intent: "Warmup — set the candidate talking, verify narrative matches the CV.",
      whatGoodLooksLike: "Concrete scope, their specific role, one measurable outcome.",
      probes: ["What was YOUR contribution vs the team's?", "How was success measured?"],
      difficulty: "warmup",
    },
    {
      question: `Your CV highlights ${claim} — what was the hardest decision there?`,
      intent: `Verify the CV's ${claim} claim under questioning.`,
      whatGoodLooksLike: "Owns a real tradeoff; can defend the choice and name what they'd do differently.",
      probes: ["What did you reject, and why?", "Who disagreed with you?"],
      difficulty: "core",
    },
    {
      question: `How did you use ${tool} in practice, and where did it fall short?`,
      intent: `Depth check on ${tool} — separates hands-on from buzzword exposure.`,
      whatGoodLooksLike: "Specifics: versions, constraints, failure modes — not textbook definitions.",
      probes: ["What would you choose instead today?", "What surprised you about it?"],
      difficulty: "core",
    },
    {
      question: "Tell me about a time you shipped something that failed.",
      intent: "Pressure — ownership, honesty, learning loop.",
      whatGoodLooksLike: "Takes ownership without blaming; names the lesson and the changed behavior.",
      probes: ["What did the postmortem change?", "How did you tell stakeholders?"],
      difficulty: "pressure",
    },
    {
      question: "You have two deadlines colliding and half the information you need. What do you do?",
      intent: "Pressure — judgment under ambiguity.",
      whatGoodLooksLike: "Prioritizes explicitly, communicates early, makes a defensible call.",
      probes: ["What would you cut first?", "Who do you tell, and when?"],
      difficulty: "pressure",
    },
  ];
  return { questions };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "has", "was", "were", "will", "would",
  "their", "they", "them", "then", "than", "your", "you", "our", "are", "can", "not", "but", "all",
  "any", "who", "what", "when", "how", "why", "his", "her", "she", "him", "its", "into", "onto",
  "over", "under", "about", "across", "after", "before", "between", "during", "through", "years",
  "year", "experience", "work", "working", "team", "role", "strong", "ability", "skills", "including",
  "using", "used", "new", "other", "more", "most", "also", "such", "must", "should", "may", "per",
]);

/** Clamp LLM output into the contract — never trust unvalidated JSON. */
export function normalizeSheet(raw: unknown): QuestionSheet | null {
  const questions = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return null;
  const clean: SheetQuestion[] = [];
  for (const q of questions) {
    const rec = q as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    if (question.length < 8) continue;
    const difficulty = rec.difficulty === "warmup" || rec.difficulty === "core" || rec.difficulty === "pressure"
      ? rec.difficulty
      : "core";
    clean.push({
      question: question.slice(0, 400),
      intent: typeof rec.intent === "string" ? rec.intent.slice(0, 300) : "",
      whatGoodLooksLike: typeof rec.whatGoodLooksLike === "string" ? rec.whatGoodLooksLike.slice(0, 400) : "",
      probes: Array.isArray(rec.probes)
        ? rec.probes.filter((p): p is string => typeof p === "string" && p.trim().length > 3).slice(0, 3).map((p) => p.slice(0, 200))
        : [],
      difficulty,
    });
  }
  if (clean.length === 0) return null;
  return { questions: clean.slice(0, 15) };
}
