/**
 * Answer post-processing (reference `answerPolish.ts` parity, compact):
 * strips JSON-envelope leakage, scaffolding misfires and AI tells, and
 * compresses outlines/talking points into speakable lines. Pure functions.
 */
import type { CoachFramework } from "./judge.js";

/** Text that must never leak into spoken output. */
const LEAK_PATTERNS: RegExp[] = [
  /^\s*```/, // code fences
  /^\s*\{[\s\S]*\}\s*$/, // raw JSON envelope
  /^\s*"(detected_question|suggested_outline|talking_points|summary)"\s*:/, // schema stubs
  /^\s*(JSON|Output|Response)\s*[:=]/i,
  /as an ai(?: language model)?/i,
  /i(?:'m| am) (?:just )?an ai\b/i,
];

const AI_TELLS: [RegExp, string][] = [
  [/\bdelve (?:in)?(?:de)?to\b/gi, "look at"],
  [/\bleverage\b/gi, "use"],
  [/\butilize\b/gi, "use"],
  [/\bit(?:'s| is) important to note that\b/gi, ""],
  [/\bi(?:'d| would) be happy to\b/gi, ""],
  [/\bgreat question!?\b/gi, ""],
  [/\bin today's fast-paced world,?\s*/gi, ""],
  [/\bmoreover\b/gi, "also"],
  [/\bfurthermore\b/gi, "also"],
  [/\bin conclusion,?\s*/gi, "so"],
  [/\bunique blend of\b/gi, "mix of"],
  [/\bactionable insights\b/gi, "clear next steps"],
  [/\bbest-in-class\b/gi, "strong"],
  [/\b—\b/g, ", "],
  [/\b–\b/g, "-"],
];

export function stripLeakage(text: string): string {
  let t = text.trim();
  for (const re of LEAK_PATTERNS) {
    if (re.test(t)) {
      t = t.replace(re, "").trim();
    }
  }
  for (const [re, rep] of AI_TELLS) t = t.replace(re, rep);
  return t.replace(/\s{2,}/g, " ").trim();
}

/** Split a raw line into sentence-ish speakable chunks (max 3 per point). */
export function speakable(text: string, maxSentences = 3): string {
  const cleaned = stripLeakage(text).replace(/^[-*•\d.)\s]+/, "");
  const parts = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, maxSentences).join(" ");
}

/**
 * Full framework sanitizer: drops leakage, compresses to speakable lines,
 * enforces reference LENGTH LAW (outline ≤4, points ≤3, each ≤2 sentences).
 * Returns null when nothing speakable survives — caller should drop the
 * suggestion instead of showing garbage.
 */
export function sanitizeCoachFramework(fw: CoachFramework): CoachFramework | null {
  const question = stripLeakage(fw.detected_question ?? "").slice(0, 300);
  const outline = (fw.suggested_outline ?? [])
    .map((o) => speakable(o, 2))
    .filter((o) => o.length > 2)
    .slice(0, 4);
  const points = (fw.talking_points ?? [])
    .map((p) => speakable(p, 2))
    .filter((p) => p.length > 2)
    .slice(0, 3);

  if (!question && outline.length === 0 && points.length === 0) return null;
  return {
    detected_question: question,
    suggested_outline: outline,
    talking_points: points,
    confidence: fw.confidence,
    requires_user_review: fw.requires_user_review,
  };
}
