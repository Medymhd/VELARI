/**
 * Prepared-answer recall (rival knowledge-packs parity, compact): matches a
 * live interviewer question against the user's drilled Q&A bank using
 * stopword-filtered token overlap. Pure functions — no provider calls, so a
 * match surfaces in ~0ms ahead of the LLM coach.
 */
export interface PreparedQa {
  id: string;
  title: string;
  content: string;
}

export interface PreparedMatch {
  qa: PreparedQa;
  score: number; // 0..1 overlap of distinctive tokens
  answer: string; // the drilled answer, trimmed for display
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "to", "of", "in", "on", "at", "for",
  "with", "about", "as", "by", "from", "is", "are", "was", "were", "be", "been", "being", "do",
  "does", "did", "have", "has", "had", "you", "your", "yours", "i", "me", "my", "we", "our",
  "it", "its", "this", "that", "these", "those", "what", "how", "why", "when", "where", "which",
  "who", "whom", "can", "could", "would", "should", "will", "shall", "may", "might", "tell",
  "describe", "walk", "give", "let", "us", "know", "think", "like", "there", "their", "them",
  "they", "he", "she", "his", "her", "not", "no", "yes", "any", "some", "more", "most", "much",
  "very", "just", "also", "into", "up", "out", "over", "under", "again", "own", "same",
]);

/** Interview rephrase groups — interviewers never use your drilled wording. */
const SYNONYM_GROUPS: string[][] = [
  ["conflict", "disagree", "disagreement", "friction", "argue", "argument", "clash"],
  ["colleague", "teammate", "coworker", "peer", "team", "manager", "stakeholder"],
  ["weakness", "flaw", "shortcoming", "weaknesses", "improve"],
  ["failure", "fail", "mistake", "mistakes", "error"],
  ["lead", "leadership", "influence", "influenced", "authority"],
  ["prioritize", "priority", "priorities", "urgent"],
  ["scale", "scaling", "scaled", "growth"],
  ["learn", "learned", "lesson"],
  ["challenge", "difficult", "hard", "tough"],
];

function stem(w: string): string {
  // Iterative suffix strip — both sides of the comparison normalize the same
  // way ("disagreed" → "disagr", "disagree" → "disagr").
  let s = w;
  for (;;) {
    if (s.length > 5 && s.endsWith("ing")) { s = s.slice(0, -3); continue; }
    if (s.length > 5 && s.endsWith("ed")) { s = s.slice(0, -2); continue; }
    if (s.length > 5 && s.endsWith("es")) { s = s.slice(0, -2); continue; }
    if (s.length > 5 && s.endsWith("e")) { s = s.slice(0, -1); continue; }
    if (s.length > 4 && s.endsWith("s")) { s = s.slice(0, -1); continue; }
    if (s.length > 6 && s.endsWith("ment")) { s = s.slice(0, -4); continue; }
    if (s.length > 7 && s.endsWith("tion")) { s = s.slice(0, -4); continue; }
    return s;
  }
}

const SYNONYM_OF = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const head = stem(group[0]!);
  for (const w of group) SYNONYM_OF.set(stem(w), head);
}

function canonical(w: string): string {
  const s = stem(w);
  return SYNONYM_OF.get(s) ?? s;
}

/** Distinctive canonical tokens — stopwords removed, stemmed, synonyms merged.
 *  Trailing dots stripped ("teammate." → "teammate") so sentence punctuation
 *  can't split the synonym match; inner dots stay ("node.js"). */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) ?? []) {
    const w = raw.replace(/\.+$/, "");
    if (w.length >= 2 && !STOPWORDS.has(w)) out.add(canonical(w));
  }
  return out;
}

/**
 * Best Q&A match for a live question. Returns null below the relevance floor
 * (0.34 ≈ a third of distinctive tokens shared) — a wrong "prepared" answer is
 * worse than no answer.
 */
export function matchPreparedQa(question: string, bank: PreparedQa[], floor = 0.34): PreparedMatch | null {
  const qTokens = tokens(question);
  if (qTokens.size === 0 || bank.length === 0) return null;

  let best: PreparedMatch | null = null;
  for (const qa of bank) {
    // Q&A content format: "Q: <question> A: <answer>" (drilled flashcard style);
    // fall back to whole content when no marker present.
    const qIdx = qa.content.toLowerCase().indexOf("a:");
    const qaQuestion = qIdx >= 0 ? qa.content.slice(0, qIdx).replace(/^\s*q:\s*/i, "") : qa.title;
    const answer = qIdx >= 0 ? qa.content.slice(qIdx + 2).trim() : qa.content.trim();
    const overlap = [...tokens(question).values()].filter((t) => tokens(qaQuestion).has(t) || tokens(qa.content).has(t)).length;
    const denom = Math.max(1, qTokens.size);
    const score = overlap / denom;
    if (score >= floor && (!best || score > best.score)) {
      best = { qa, score, answer: answer.slice(0, 1500) };
    }
  }
  return best;
}
