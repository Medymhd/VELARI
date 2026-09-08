/**
 * Tolerant answer cache — a question asked (nearly) before is answered from
 * cache in ~0ms instead of an LLM call.
 *
 * Three lookup tiers, cheapest first:
 *   0. Normalized exact  — hash(normalize(question)+mode+length+prepHash).
 *      Microseconds. Catches trivial diffs (punctuation/case/spacing).
 *   1. Token-overlap fuzzy — stem-lite Jaccard against the in-memory index
 *      (workspace's latest ~500 entries). Handles "How would you evaluate…"
 *      ≈ "How do you evaluate…". ≥0.80 hit, 0.65–0.80 fuzzy hit.
 *   2. Vector cosine — hashed-bag embeddings (free, local, no keys) with an
 *      OpenAI-compatible embedder slotting in when configured. Deep paraphrase
 *      net. ≥0.92 hit, 0.85–0.92 fuzzy.
 *
 * Only judge-accepted, sanitized, confidence ≥0.7 outputs are ever cached.
 * `prepHash` is part of every key and the fuzzy/vector match predicate, so
 * changed prep materials never serve stale answers.
 */
import { createHash } from "node:crypto";

const STOPWORDS = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "and", "or", "with", "what", "how", "do", "does", "did", "you", "your", "i", "me", "my", "it", "that", "this", "would", "should", "could", "using", "use", "about", "tell"]);

/** Normalize: lowercase, strip punctuation, collapse whitespace, unify quotes. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stem-lite: a cheap suffix collapse so inflections match (evaluate/evaluating/evaluation).
 *  Single-rule (no cascade) to avoid over-stemming; Jaccard absorbs the residue. */
export function stemLite(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 5 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 6 && s.endsWith("tion")) s = s.slice(0, -3); // -ion, keep the t: evaluation/evaluating converge
  else if (s.length > 5 && s.endsWith("ness")) s = s.slice(0, -4);
  else if (s.length > 5 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  else if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

/** Content tokens: stopword-filtered, stemmed, deduped. */
export function questionTokens(q: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeQuestion(q).split(" ")) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stemLite(w));
  }
  return [...out];
}

/** Jaccard similarity over token sets (0..1). */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (sb.has(t)) shared += 1;
  const union = new Set([...a, ...b]).size;
  return shared / union;
}

export function keyHashFor(parts: { question: string; mode: string; length: string; prepHash: string }): string {
  return createHash("sha256").update(`${normalizeQuestion(parts.question)}|${parts.mode}|${parts.length}|${parts.prepHash}`).digest("hex");
}

/** Deterministic hash of the active prep materials — cache invalidation. */
export function prepHashOf(prepContext: string | undefined, qaBank: { id: string; title: string; content: string }[]): string {
  const prep = prepContext ?? "";
  const qa = qaBank.map((q) => `${q.id}:${q.title}:${q.content}`).join("|");
  return createHash("sha256").update(`${prep.length}:${prep}||${qa.length}:${qa}`).digest("hex").slice(0, 32);
}

export interface CacheHit {
  key: "exact" | "fuzzy" | "vector";
  score: number;
  matchedQuestion: string;
  frameworkJson: Record<string, unknown>;
  answerText: string;
  id: string;
}

interface CacheRecord {
  id: string;
  question: string;
  tokens: string[];
  embedding: number[];
  frameworkJson: Record<string, unknown>;
  answerText: string;
  mode: string;
  length: string;
  prepHash: string;
}

/** Cosine similarity (identical math to the shared embeddings util — local copy avoids a package import cycle). */
function cosine(a: number[], b: number[]): number {
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

/**
 * In-memory cache index — loaded once per session, mutated on seed.
 * Lookup touches memory only; Postgres is hit on load and seed.
 */
export class AnswerCache {
  private records: CacheRecord[] = [];
  private readonly maxRecords: number;

  constructor(
    private readonly embed: (texts: string[]) => Promise<number[][]>,
    private readonly thresholds: { exactFuzzy: number; fuzzyFloor: number; vectorHit: number; vectorFuzzy: number } = {
      exactFuzzy: 0.8,
      fuzzyFloor: 0.65,
      vectorHit: 0.92,
      vectorFuzzy: 0.85,
    },
    maxRecords = 500,
  ) {
    this.maxRecords = maxRecords;
  }

  load(entries: {
    id: string;
    question: string;
    tokensJson: unknown;
    embeddingJson: unknown;
    frameworkJson: unknown;
    answerText: string;
    mode: string;
    length: string;
    prepHash: string;
  }[]): void {
    this.records = entries
      .map((e) => ({
        id: e.id,
        question: e.question,
        tokens: Array.isArray(e.tokensJson) ? (e.tokensJson as string[]) : [],
        embedding: Array.isArray(e.embeddingJson) ? (e.embeddingJson as number[]) : [],
        frameworkJson: (e.frameworkJson ?? {}) as Record<string, unknown>,
        answerText: e.answerText,
        mode: e.mode,
        length: e.length,
        prepHash: e.prepHash,
      }))
      .slice(-this.maxRecords);
  }

  size(): number {
    return this.records.length;
  }

  async lookup(question: string, opts: { mode: string; length: string; prepHash: string }): Promise<CacheHit | null> {
    const norm = normalizeQuestion(question);
    const qTokens = questionTokens(question);
    const exact = keyHashFor({ question, mode: opts.mode, length: opts.length, prepHash: opts.prepHash });

    // Tier 0 — normalized exact.
    const exactRec = this.records.find(
      (r) => r.mode === opts.mode && r.length === opts.length && r.prepHash === opts.prepHash && keyHashFor({ question: r.question, mode: r.mode, length: r.length, prepHash: r.prepHash }) === exact,
    );
    if (exactRec) {
      return { key: "exact", score: 1, matchedQuestion: exactRec.question, frameworkJson: exactRec.frameworkJson, answerText: exactRec.answerText, id: exactRec.id };
    }

    // Tier 1 — token-overlap fuzzy (same mode/length/prep only).
    let bestFuzzy: { rec: CacheRecord; score: number } | null = null;
    for (const rec of this.records) {
      if (rec.mode !== opts.mode || rec.length !== opts.length || rec.prepHash !== opts.prepHash) continue;
      const score = jaccard(qTokens, rec.tokens);
      if (score >= this.thresholds.exactFuzzy && (!bestFuzzy || score > bestFuzzy.score)) bestFuzzy = { rec, score };
    }
    if (bestFuzzy) {
      return { key: "fuzzy", score: Math.round(bestFuzzy.score * 100) / 100, matchedQuestion: bestFuzzy.rec.question, frameworkJson: bestFuzzy.rec.frameworkJson, answerText: bestFuzzy.rec.answerText, id: bestFuzzy.rec.id };
    }

    // Tier 2 — vector cosine (deep paraphrases; only reached when tiers 0/1 miss).
    let qVec: number[];
    try {
      const vecs = await this.embed([question]);
      qVec = vecs[0] ?? [];
    } catch {
      return null; // embedder down — cache is best-effort, never blocks the LLM path
    }
    let bestVec: { rec: CacheRecord; score: number } | null = null;
    for (const rec of this.records) {
      if (rec.mode !== opts.mode || rec.length !== opts.length || rec.prepHash !== opts.prepHash) continue;
      if (rec.embedding.length === 0) continue;
      const score = cosine(qVec, rec.embedding);
      if (score >= this.thresholds.vectorHit && (!bestVec || score > bestVec.score)) bestVec = { rec, score };
    }
    if (bestVec) {
      return { key: "vector", score: Math.round(bestVec.score * 100) / 100, matchedQuestion: bestVec.rec.question, frameworkJson: bestVec.rec.frameworkJson, answerText: bestVec.rec.answerText, id: bestVec.rec.id };
    }

    // 0.85–0.92 vector similarity = plausible but not certain — surface as fuzzy.
    if (bestVec === null) {
      for (const rec of this.records) {
        if (rec.mode !== opts.mode || rec.length !== opts.length || rec.prepHash !== opts.prepHash) continue;
        if (rec.embedding.length === 0) continue;
        const score = cosine(qVec, rec.embedding);
        if (score >= this.thresholds.vectorFuzzy && (!bestVec || score > bestVec.score)) bestVec = { rec, score };
      }
      if (bestVec) {
        return { key: "fuzzy", score: Math.round(bestVec.score * 100) / 100, matchedQuestion: bestVec.rec.question, frameworkJson: bestVec.rec.frameworkJson, answerText: bestVec.rec.answerText, id: bestVec.rec.id };
      }
    }
    return null;
  }

  seed(entry: {
    id: string;
    question: string;
    tokens: string[];
    embedding: number[];
    frameworkJson: Record<string, unknown>;
    answerText: string;
    mode: string;
    length: string;
    prepHash: string;
  }): void {
    const existingIdx = this.records.findIndex((r) => r.mode === entry.mode && r.length === entry.length && r.prepHash === entry.prepHash && keyHashFor({ question: r.question, mode: r.mode, length: r.length, prepHash: r.prepHash }) === keyHashFor({ question: entry.question, mode: entry.mode, length: entry.length, prepHash: entry.prepHash }));
    if (existingIdx >= 0) {
      this.records[existingIdx] = entry;
      return;
    }
    this.records.push(entry);
    if (this.records.length > this.maxRecords) this.records.shift();
  }
}
