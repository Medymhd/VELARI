/**
 * Style adaptation — captures a user's writing voice from samples and
 * generates prompt modifiers so AI output reads naturally in that voice.
 * This is legitimate personalization (Grammarly Business tone matching,
 * Jasper brand voice) — NOT detection evasion. The provenance layer
 * correctly labels every output as agent/human regardless of style.
 */

export interface StyleProfile {
  /** Average sentence length in words. */
  avgSentenceLength: number;
  /** Sentence length variance (burstiness — humans vary, models are uniform). */
  sentenceLengthVariance: number;
  /** Vocabulary richness: unique words / total words (0–1). */
  lexicalDiversity: number;
  /** Common transition words the user favors. */
  transitions: string[];
  /** Formality markers: contractions, slang, hedging. */
  contractions: boolean;
  hedging: boolean;
  /** First person: I/my vs passive/third person. */
  firstPerson: boolean;
  /** Punctuation style: em-dashes, semicolons, exclamation frequency. */
  punctuation: {
    emDash: number;
    semicolon: number;
    exclamation: number;
    question: number;
  };
  /** Rare/technical terms the user uses (echoed in output). */
  domainTerms: string[];
}

/** Build a StyleProfile from writing samples. */
export function captureStyleProfile(samples: string[]): StyleProfile {
  const text = samples.join("\n").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const unique = new Set(words);

  const lengths = sentences.map((s) => (s.match(/\S+/g) ?? []).length).filter((n) => n > 0);
  const avgLen = lengths.length ? lengths.reduce((a, v) => a + v, 0) / lengths.length : 14;
  const variance = lengths.length
    ? lengths.reduce((a, v) => a + (v - avgLen) ** 2, 0) / lengths.length
    : 25;

  const transitions = [
    "however", "therefore", "moreover", "furthermore", "meanwhile",
    "consequently", "additionally", "specifically", "notably", "in practice",
  ].filter((t) => text.toLowerCase().includes(t));

  const domainTerms = [...unique]
    .filter((w) => w.length > 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);

  const punctuation = {
    emDash: (text.match(/—|--/g) ?? []).length,
    semicolon: (text.match(/;/g) ?? []).length,
    exclamation: (text.match(/!/g) ?? []).length,
    question: (text.match(/\?/g) ?? []).length,
  };

  return {
    avgSentenceLength: Math.round(avgLen * 10) / 10,
    sentenceLengthVariance: Math.round(variance * 10) / 10,
    lexicalDiversity: words.length ? Math.round((unique.size / words.length) * 100) / 100 : 0,
    transitions,
    contractions: /\b\w+'(?:s|t|re|ve|ll|d)\b/i.test(text),
    hedging: /\b(?:perhaps|arguably|somewhat|fairly|relatively|generally|typically)\b/i.test(text),
    firstPerson: /\b(?:I|my|me|we|our)\b/.test(text),
    punctuation,
    domainTerms,
  };
}

/** Generate prompt modifiers from a style profile — injected into system messages. */
export function stylePrompt(profile: StyleProfile): string {
  const lines: string[] = [];
  lines.push(`Target sentence length: ~${profile.avgSentenceLength} words, with natural variation (avoid uniform rhythm).`);
  lines.push(`Vocabulary: ${profile.lexicalDiversity > 0.5 ? "varied and precise" : "direct and focused"} — use familiar words unless a technical term is exact.`);
  if (profile.contractions) lines.push("Use contractions naturally.");
  if (profile.hedging) lines.push("Use measured language (perhaps, generally, in practice) rather than absolute claims.");
  lines.push(profile.firstPerson ? "Write in first person (I, my)." : "Avoid heavy first-person; prefer direct statements.");
  if (profile.transitions.length > 0) lines.push(`Favored transitions: ${profile.transitions.slice(0, 5).join(", ")} (use sparingly, not in every sentence).`);
  if (profile.domainTerms.length > 0) lines.push(`Domain vocabulary to echo where relevant: ${profile.domainTerms.slice(0, 5).join(", ")}.`);
  lines.push("Vary sentence structure: mix short declaratives with longer compound sentences. Do not produce uniformly paced output.");
  return lines.join("\n");
}

/** Merge a style modifier into an existing system prompt (appends). */
export function withStyle(systemPrompt: string, style: StyleProfile | undefined): string {
  if (!style) return systemPrompt;
  return `${systemPrompt}\n\nStyle guide (adapt output to this voice):\n${stylePrompt(style)}`;
}

/** Storage serialization — persist in workspace policy_json or user profile. */
export function serializeProfile(profile: StyleProfile): string {
  return JSON.stringify(profile);
}

export function deserializeProfile(json: string): StyleProfile | null {
  try {
    const p = JSON.parse(json) as StyleProfile;
    if (typeof p.avgSentenceLength !== "number" || typeof p.lexicalDiversity !== "number") return null;
    return p;
  } catch {
    return null;
  }
}
