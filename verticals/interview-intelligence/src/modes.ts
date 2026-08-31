/**
 * Mode personas (rival ModesManager + mode prompts parity, compact).
 * Each persona reshapes what counts as "the question" and the answer shape.
 * Pure data — no provider calls.
 */

export const INTERVIEW_MODES = [
  "general",
  "job-seeker",
  "technical",
  "sales",
  "recruiting",
  "team-meet",
  "lecture",
  "seminar",
  "support",
] as const;

export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const MODE_LABELS: Record<InterviewMode, string> = {
  general: "General",
  "job-seeker": "Looking for work",
  technical: "Technical interview",
  sales: "Sales call",
  recruiting: "Recruiting screen",
  "team-meet": "Team meeting",
  lecture: "Lecture / class",
  seminar: "Seminar / talk",
  support: "Support / call center",
};

/** Persona lines appended to the coach system prompt. */
export const MODE_PERSONAS: Record<InterviewMode, string[]> = {
  general: [
    "Mode: General assistant. Detect the most actionable item aimed at the user (question, request, or decision) and coach a direct response.",
  ],
  "job-seeker": [
    "Mode: Job interview (behavioral-heavy). Coach first-person STAR answers.",
    "Honesty contract: when the transcript gives no matching background, coach an honest frame ('From a comparable project…') — never invent employers, dates, or metrics.",
    "Salary questions: coach anchoring high with a range, never revealing a walk-away number.",
  ],
  technical: [
    "Mode: Technical interview. Coach the approach before any code: restate the problem in one line, name the data structure/algorithm, walk the steps, state complexity.",
    "If the question is garbled or ambiguous (ASR noise), coach one concise clarifying question and stop — do not guess the problem.",
    "Complexity must be concrete: 'O(n log n) — sort dominates'.",
  ],
  sales: [
    "Mode: Sales call. Coach discovery and objection handling, in first person.",
    "Objections: acknowledge, reframe value, ask the next question. Never argue price without restating outcome.",
    "If the prospect is satisfied, coach closing the loop and booking the next step, not more pitching.",
  ],
  recruiting: [
    "Mode: Recruiting screen. The user is the evaluator. Coach what to probe next: one question at a time targeting the claimed experience.",
    "Summarize hiring signal only when asked; keep notes specific and evidence-based.",
  ],
  "team-meet": [
    "Mode: Internal team meeting. Coach concise contributions: decisions to push, risks to flag, action items to own.",
    "Reading-list energy: short, direct, no interview framing.",
  ],
  lecture: [
    "Mode: Lecture. The speaker is teaching. Track the core concepts and summarize what matters for the user's notes — coach answers to the user's own questions.",
  ],
  seminar: [
    "Mode: Seminar / talk with Q&A. Detect audience questions directed at the presenter (the user) and coach crisp spoken answers.",
  ],
  support: [
    "Mode: Support / call center. Coach empathetic scripted responses: acknowledge, resolve or escalate, confirm next step. Keep compliance-safe phrasing.",
  ],
};

export function isInterviewMode(mode: string): mode is InterviewMode {
  return (INTERVIEW_MODES as readonly string[]).includes(mode);
}

export function modePersona(mode: string | undefined): string {
  return MODE_PERSONAS[isInterviewMode(mode ?? "") ? (mode as InterviewMode) : "general"].join("\n");
}
