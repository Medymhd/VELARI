/**
 * Live-coach prompt assembly (doc Â§7). Pure functions â€” no provider calls.
 */
import type { ChatMessage } from "@app/contracts";

export interface CoachContextInput {
  verbatimTranscript: string;
  rollingSummary?: string | undefined;
  roleDescription?: string | undefined;
}

export function buildCoachMessages(input: CoachContextInput): ChatMessage[] {
  const system = [
    "You are App's live interview coach.",
    "Detect the interviewer's most recent question and produce a compact answer framework.",
    "Respond ONLY with JSON matching:",
    '{"detected_question":string,"suggested_outline":string[],"talking_points":string[],"confidence":number,"requires_user_review":boolean}',
    "Rules: max 4 outline items; max 3 talking points; talking points must cite concrete structure (STAR), not generic advice;",
    "if the transcript contains no question, set detected_question to '' and confidence 0.",
  ].join("\n");
  const context = [
    input.rollingSummary ? `Earlier session summary:\n${input.rollingSummary}` : "",
    `Recent verbatim transcript:\n${input.verbatimTranscript}`,
    input.roleDescription ? `Candidate role/context:\n${input.roleDescription}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: context },
  ];
}

/** Offline fallback when every candidate provider is down (graceful degradation). */
export function offlineFramework(transcript: string): Record<string, unknown> {
  const q = transcript.split(/(?<=[.?])\s+/).filter((s) => s.includes("?")).at(-1) ?? "";
  return {
    detected_question: q.slice(0, 300),
    suggested_outline: ["Situation", "Task", "Action", "Result"],
    talking_points: [
      "Pick one specific story; state the stakes in one line",
      "Describe your decision and the tradeoff you owned",
      "Quantify the result; add one lesson you kept",
    ],
    confidence: q ? 0.35 : 0.1,
    requires_user_review: true,
  };
}

export const QUESTION_BANK = [
  { id: "behavioral.conflict", text: "Tell me about a conflict with a colleague and how you resolved it.", theme: "behavioral" },
  { id: "behavioral.failure", text: "Describe a professional failure and what changed afterward.", theme: "behavioral" },
  { id: "technical.scaling", text: "Walk through scaling a system past its original limits.", theme: "technical" },
  { id: "leadership.influence", text: "How did you drive an outcome without formal authority?", theme: "leadership" },
  { id: "case.prioritization", text: "Two urgent projects, resources for one â€” how do you decide?", theme: "case" },
] as const;


