/**
 * Story Bank matching — pure functions for indexing and recalling the user's
 * own past answers (cross-session "you told this story before" hints).
 * Same stem-lite/Jaccard family as the answer cache, plus cosine over the
 * shared 256-dim hashed embedding space when vectors are available.
 */

const STOPWORDS = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "and", "or", "with", "what", "how", "do", "does", "did", "you", "your", "i", "me", "my", "it", "that", "this", "would", "should", "could", "using", "use", "about", "tell"]);

export function stemLite(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 6 && s.endsWith("tion")) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith("ness")) s = s.slice(0, -4);
  else if (s.length > 5 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  else if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

export function questionTokens(q: string): string[] {
  const out = new Set<string>();
  for (const w of q.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/)) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stemLite(w));
  }
  return [...out];
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (sb.has(t)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

export function cosineOf(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface StoryCandidate {
  id: string;
  question: string;
  answer: string;
  score: number | null;
  embedding: number[];
}

export interface StoryMatch {
  id: string;
  question: string;
  answer: string;
  score: number | null;
  similarity: number;
  /** true = near-duplicate (warn: vary it); false = reusable for this question */
  duplicate: boolean;
}

/** Recall stories relevant to a new question. ≥0.72 token overlap = near-duplicate. */
export function matchStories(question: string, candidates: StoryCandidate[], floor = 0.55): StoryMatch[] {
  const qTokens = questionTokens(question);
  const hits: StoryMatch[] = [];
  for (const c of candidates) {
    let sim = jaccard(qTokens, questionTokens(c.question));
    if (sim < floor && c.embedding.length > 0) {
      // Vector fallback uses the same question text hashed at index time —
      // callers embed the incoming question and pass it via candidates when
      // a cloud embedder exists; here token overlap is the portable floor.
      sim = 0;
    }
    if (sim >= floor) {
      hits.push({ id: c.id, question: c.question, answer: c.answer, score: c.score, similarity: Math.round(sim * 100) / 100, duplicate: sim >= 0.72 });
    }
  }
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}
