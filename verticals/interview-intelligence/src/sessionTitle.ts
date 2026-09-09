/**
 * Interviewer + candidate session auto-naming. A session called "Untitled" is
 * a session the user must rename by hand — instead the model names it once
 * from what it knows: CV/JD context titles and content, then the live
 * transcript. Pure functions + a prompt builder; the backend route persists
 * nothing itself (the caller PATCHes the title through the platform route).
 */
import type { ChatMessage } from "@app/contracts";

export function buildTitleMessages(cv: string, jd: string, transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Name an interview session in at most 8 words. Prefer 'Candidate name — Target role' when the CV names the person and the JD names the role; else 'Role — Company'; else the topic of the first questions.",
        "Plain text only: no quotes, no punctuation flourishes, no preamble.",
        "Output ONLY JSON: {\"title\": string}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        cv ? `Candidate CV (head):\n${cv.slice(0, 3000)}` : "",
        jd ? `Job description (head):\n${jd.slice(0, 2000)}` : "",
        transcript ? `Opening transcript:\n${transcript.slice(0, 1500)}` : "",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

/** Strip quotes/flourishes, collapse whitespace, hard-cap length. */
export function normalizeTitle(raw: unknown): string {
  const t = String(raw ?? "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= 60 && t.length > 0) return t;
  if (t.length === 0) return "";
  return t.slice(0, 60).replace(/\s+\S*$/, "");
}

const FILE_EXT = /\.(pdf|docx?|txt|md|xls[x]?|csv)$/i;

/** Deterministic fallback: JD title + CV title, else transcript topic line. */
export function offlineTitle(cvTitle: string, jdTitle: string, transcript: string): string {
  const clean = (s: string) => s.replace(FILE_EXT, "").replace(/[_-]+/g, " ").trim();
  const jd = clean(jdTitle);
  const cv = clean(cvTitle);
  if (jd && cv) return normalizeTitle(`${jd} — ${cv}`);
  if (jd) return normalizeTitle(jd);
  if (cv) return normalizeTitle(cv);
  const firstLine = transcript.split("\n").map((l) => l.trim()).find((l) => l.length >= 8) ?? "";
  return normalizeTitle(firstLine);
}
