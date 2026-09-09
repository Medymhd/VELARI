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
 * Best Q&A match for a live question. Handles both marked banks ("Q: … A: …")
 * and unmarked docs (question sentence followed by the answer — the common
 * docx extraction shape): scans sentence windows of the content for the best
 * token overlap, then the answer is what FOLLOWS the matched span. Returns
 * null below the relevance floor — a wrong "prepared" answer is worse than
 * no answer.
 */
export function matchPreparedQa(question: string, bank: PreparedQa[], floor = 0.34): PreparedMatch | null {
  const qTokens = tokens(question);
  if (bank.length === 0) return null;

  let best: PreparedMatch | null = null;
  for (const qa of bank) {
    // Marked format wins when present — an explicit "Q: … A: …" is a real
    // drill, so any question size may match it.
    const aMatch = /\bA\s*:\s*/i.exec(qa.content);
    const qMarked = /\bQ\s*:/i.test(qa.content);
    if (qMarked && aMatch) {
      const qaQuestion = qa.content.slice(0, aMatch.index).replace(/^\s*Q\s*:\s*/i, "").trim();
      const answer = qa.content.slice(aMatch.index + aMatch[0].length).trim();
      const score = overlapScore(question, qaQuestion) > overlapScore(question, qa.content)
        ? overlapScore(question, qaQuestion)
        : overlapScore(question, qa.content);
      if (score >= floor && (!best || score > best.score)) {
        best = { qa, score, answer: answer.slice(0, 1500) };
      }
      continue;
    }

    // Unmarked docs: the "question" is inferred from a content window, so it
    // must earn trust. Two guards kill the false-100% class:
    //  (a) the live question needs ≥2 distinctive tokens — one-token
    //      questions ("Tell me about yourself." → just "yourself") otherwise
    //      score a perfect 1.0 against any window containing that token;
    //  (b) the matched window must be question-shaped — a window of answer
    //      prose scoring high is a false positive, not a drilled Q&A.
    if (qTokens.size < 2) continue;
    const sentences = qa.content.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    if (sentences.length <= 1) {
      if (!looksQuestion(qa.content)) continue;
      const score = overlapScore(question, qa.content);
      if (score >= floor && (!best || score > best.score)) {
        best = { qa, score, answer: qa.content.trim().slice(0, 1500) };
      }
      continue;
    }
    for (let i = 0; i < sentences.length; i++) {
      const window = sentences.slice(i, i + 3).join(" ");
      if (!looksQuestion(window)) continue;
      const score = overlapScore(question, window);
      if (score >= floor && (!best || score > best.score)) {
        const answer = sentences.slice(i + 3).join(" ").trim() || sentences.slice(i, i + 3).join(" ").trim();
        best = { qa, score, answer: answer.slice(0, 1500) };
      }
    }
  }
  return best;
}

/** Question-shaped text: contains '?', or opens with an interrogative or
 *  imperative interview verb. Windows of answer prose ("I've also worked
 *  with…") fail this and can never pose as a drilled question. */
function looksQuestion(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(tell|what|how|why|when|who|where|walk|describe|explain|give|share|discuss|can|could|do|did|have|are|would)\b/i.test(t);
}

/** Token overlap of `question` against `text`, normalized by question size. */
function overlapScore(question: string, text: string): number {
  const q = tokens(question);
  if (q.size === 0) return 0;
  const t = tokens(text);
  let hits = 0;
  for (const tok of q) if (t.has(tok)) hits += 1;
  return hits / q.size;
}
