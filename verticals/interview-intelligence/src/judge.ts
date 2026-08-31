/**
 * Auto-answer judge (reference `AutoAnswerJudge` parity) + mid-call rolling
 * summary prompt (reference `ChunkSummaryGenerator` parity). Pure functions —
 * no provider calls.
 */
import type { ChatMessage } from "@app/contracts";

export interface CoachFramework {
  detected_question: string;
  suggested_outline: string[];
  talking_points: string[];
  confidence: number;
  requires_user_review: boolean;
}

export interface JudgeState {
  lastQuestion: string;
  lastAcceptedAtMs: number;
}

export function createJudgeState(): JudgeState {
  return { lastQuestion: "", lastAcceptedAtMs: Number.NEGATIVE_INFINITY };
}

export interface JudgeVerdict {
  accept: boolean;
  reason: "ok" | "low_confidence" | "no_question" | "empty_outline" | "duplicate_question";
}

/**
 * Filters weak or repetitive coach output before it reaches the UI.
 * Mutates `state` only on accept, so retries of the same question inside the
 * duplicate window stay suppressed.
 */
export function judgeSuggestion(
  state: JudgeState,
  fw: Partial<CoachFramework>,
  atMs: number,
  opts: { minConfidence?: number; duplicateWindowMs?: number } = {},
): JudgeVerdict {
  const minConfidence = opts.minConfidence ?? 0.4;
  const duplicateWindowMs = opts.duplicateWindowMs ?? 60_000;

  if (typeof fw.confidence !== "number" || fw.confidence < minConfidence) {
    return { accept: false, reason: "low_confidence" };
  }
  if (!fw.detected_question) {
    return { accept: false, reason: "no_question" };
  }
  if (!Array.isArray(fw.suggested_outline) || fw.suggested_outline.length === 0) {
    return { accept: false, reason: "empty_outline" };
  }
  if (fw.detected_question === state.lastQuestion && atMs - state.lastAcceptedAtMs < duplicateWindowMs) {
    return { accept: false, reason: "duplicate_question" };
  }

  state.lastQuestion = fw.detected_question;
  state.lastAcceptedAtMs = atMs;
  return { accept: true, reason: "ok" };
}

/** Rolling ~30s summary prompt feeding the coach's context window (§7). */
export function buildChunkSummaryMessages(chunkTranscript: string, priorSummary?: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You summarize the last ~30 seconds of a live interview for the coach's context window.",
        'Respond ONLY with JSON {"summary":string,"open_question":string}.',
        "summary: 2-3 sentences of what was asked and answered. open_question: the question currently on the table (empty string when none).",
      ].join("\n"),
    },
    {
      role: "user",
      content: [priorSummary ? `Prior summary:\n${priorSummary}` : "", `Recent transcript:\n${chunkTranscript}`]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

export function offlineChunkSummary(chunkTranscript: string): { summary: string; open_question: string } {
  const lines = chunkTranscript.split("\n").filter(Boolean);
  const lastQuestionLine = lines.filter((l) => l.includes("?")).at(-1) ?? "";
  return {
    summary: lines.slice(-3).join(" ").slice(0, 280) || "Transcript quiet.",
    open_question: lastQuestionLine.slice(0, 300),
  };
}
