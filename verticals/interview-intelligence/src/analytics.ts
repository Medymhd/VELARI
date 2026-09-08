/**
 * Speech analytics — the fitness tracker for interview skill. Pure functions
 * over transcript segments (speaker-attributed): filler rate, pace, verbosity,
 * STAR structure. No LLM calls — deterministic and testable; the LLM layer
 * (judge/summary) runs separately in the pipeline.
 */

export interface AnalyzedSegment {
  text: string;
  speaker?: string | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}

export interface SessionMetrics {
  /** User words across finals. */
  wordCount: number;
  /** Filler words per 100 spoken words. */
  fillerRate: number;
  /** Words per minute across timed user segments (null when untimed). */
  wpm: number | null;
  /** Mean words per answer segment. */
  verbosity: number;
  /** 0-1 share of answer segments with STAR-shaped structure. */
  starShare: number;
  /** Segments analysed (user finals). */
  segmentCount: number;
}

const FILLERS = [
  "um", "uh", "er", "ah", "like", "basically", "actually", "literally",
  "you know", "i mean", "sort of", "kind of", "kinda", "sorta", "right", "so yeah",
];

const RESULT_MARKERS = /\b(?:result(?:ed|ing)?|increased|decreased|reduced|saved|improved|grew|grew by|cut|shipped|delivered|launched|%|percent|\d+\s?(?:k|m|x|hours?|days?|weeks?|months?|users?|customers?|requests?)\b)/i;
const ACTION_VERBS = /\b(?:led|built|designed|implemented|migrated|owned|drove|created|refactored|automated|launched|shipped|negotiated|resolved|debugged|architected|trained|evaluated)\b/i;
const SITUATION_MARKERS = /\b(?:when|while|during|at (?:my|the) (?:previous|last)|we had|there was|the team)\b/i;

export function countFillers(text: string): number {
  const lower = ` ${text.toLowerCase()} `;
  let n = 0;
  for (const f of FILLERS) {
    const re = new RegExp(`(?<=\\W)${f.replace(/ /g, "\\s+")}(?=\\W)`, "g");
    n += (lower.match(re) ?? []).length;
  }
  return n;
}

export function wordCount(text: string): number {
  return (text.match(/[A-Za-z0-9']+/g) ?? []).length;
}

/** STAR-ish shape: situation marker + owned action verb + measurable result. */
export function starScore(text: string): number {
  let score = 0;
  if (SITUATION_MARKERS.test(text)) score += 1;
  if (ACTION_VERBS.test(text)) score += 1;
  if (RESULT_MARKERS.test(text)) score += 1;
  return score; // 0-3
}

export function analyzeSession(segments: AnalyzedSegment[]): SessionMetrics {
  const userSegs = segments.filter((s) => (s.speaker ?? "user") === "user" && s.text.trim().length > 0);
  const words = userSegs.map((s) => ({ text: s.text, count: wordCount(s.text) }));
  const totalWords = words.reduce((a, w) => a + w.count, 0);
  const totalFillers = userSegs.reduce((a, s) => a + countFillers(s.text), 0);

  // Pace: only timed segments (finals carry startedAtMs/endedAtMs).
  let timedWords = 0;
  let timedMs = 0;
  for (const s of userSegs) {
    if (typeof s.startedAtMs === "number" && typeof s.endedAtMs === "number" && s.endedAtMs > s.startedAtMs) {
      timedWords += wordCount(s.text);
      timedMs += s.endedAtMs - s.startedAtMs;
    }
  }

  const starHits = userSegs.filter((s) => s.text.trim().split(/[.!?]/).length >= 2 && starScore(s.text) === 3).length;

  return {
    wordCount: totalWords,
    fillerRate: totalWords > 0 ? Math.round((totalFillers / totalWords) * 1000) / 10 : 0,
    wpm: timedMs > 5_000 ? Math.round((timedWords / (timedMs / 60_000)) * 10) / 10 : null,
    verbosity: userSegs.length > 0 ? Math.round((totalWords / userSegs.length) * 10) / 10 : 0,
    starShare: userSegs.length > 0 ? Math.round((starHits / userSegs.length) * 100) / 100 : 0,
    segmentCount: userSegs.length,
  };
}

/** Healthier direction per metric — the UI renders trend arrows from these. */
export function metricVerdicts(m: SessionMetrics): { filler: "good" | "ok" | "warn"; pace: "good" | "ok" | "warn" | null; star: "good" | "ok" | "warn" } {
  return {
    filler: m.fillerRate <= 2 ? "good" : m.fillerRate <= 5 ? "ok" : "warn",
    pace: m.wpm == null ? null : m.wpm >= 110 && m.wpm <= 165 ? "good" : m.wpm >= 90 && m.wpm <= 185 ? "ok" : "warn",
    star: m.starShare >= 0.5 ? "good" : m.starShare >= 0.25 ? "ok" : "warn",
  };
}
