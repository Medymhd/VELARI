/**
 * Utterance classification — the pipeline's ears for NATURAL conversation.
 * Real interviews are not a question grill: interviewers greet, acknowledge,
 * ask for clarification, and make statements between questions. Each type
 * routes the coach differently (question → answer framework, greeting →
 * conversational reply, clarification → re-explain, statement → bridge).
 *
 * Pure heuristics — no LLM cost, sub-microsecond. The coach prompt receives
 * the type and decides the response shape.
 */

export type UtteranceType = "question" | "greeting" | "clarification" | "statement" | "backchannel";

const GREETING_RE =
  /^(hi|hiya|hello|hey|hey there|good (morning|afternoon|evening)|nice to meet|pleasure to meet|it'?s nice to meet|how are you|how are ya|how'?s it going|how do you do|i'?m good|doing (well|good|great))\b/i;

const CLARIFICATION_RE =
  /\b(sorry|pardon( me)?|come again|say that again|repeat (that|the question)|one more time|what do you mean|what do you mean by|could you (clarify|elaborate|explain)|can you (clarify|repeat|say)|i didn'?t (catch|get|understand)|didn'?t quite (catch|get)|run that by me again|lost me)\b/i;

const QUESTION_HEAD_RE =
  /^(what|why|when|where|who|whom|which|whose|how|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|may|might|tell|describe|walk|explain|give|share|name|list|compare|outline|are you|do you)\b/i;

const BACKCHANNEL_RE =
  /^(mm+[- ]?h+m+|hmm+|yeah+|yep|yup|ok(ay)?|alright|right|sure|interesting|great|nice|cool|wow|uh[- ]?huh|aha|i see|got it|good|perfect|exactly|absolutely|thanks|thank you)\.?$/i;

/** Classify a live-transcribed interviewer utterance. */
export function classifyUtterance(text: string): UtteranceType {
  const t = text.trim();
  if (!t) return "backchannel";
  if (CLARIFICATION_RE.test(t)) return "clarification";
  if (GREETING_RE.test(t) && t.length < 80) return "greeting";
  if (t.includes("?")) return "question";
  if (BACKCHANNEL_RE.test(t)) return "backchannel";
  if (QUESTION_HEAD_RE.test(t)) return "question";
  const words = t.split(/\s+/).filter(Boolean);
  // Very short non-question utterances ("Interesting.", "Sure.") are
  // backchannel; anything longer is a statement worth responding to.
  if (words.length <= 2) return "backchannel";
  return "statement";
}

/** True when the pipeline should wake the coach for this utterance. */
export function isCoachWorthy(t: UtteranceType): boolean {
  return t !== "backchannel";
}
