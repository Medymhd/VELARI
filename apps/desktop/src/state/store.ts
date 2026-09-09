import { create } from "zustand";
import { STORAGE_PREFIX } from "brand";
import type { StealthState } from "../lib/tauri";

export type Screen = string;
// Core screens always present; vertical-specific screens are any `work/*` `interview/*` etc.
// Adding a new vertical alongside the 2 built never edits this union — shell renders whatever
// the manifest registry returns via `/v1/verticals` (dynamic, see App.tsx + server.ts discoverVerticals).

/** Who is holding the device. Candidate (default) = the app coaches YOU.
 *  Interviewer = the app helps you run the interview (question sheet, probes,
 *  talk-time). Swapping is a full context switch: nav + screens + persona. */
export type Persona = "candidate" | "interviewer";
const PERSONA_KEY = `${STORAGE_PREFIX}_persona`;

/** Titles the app itself assigns before the model (or user) names a session. */
const DEFAULT_TITLES = new Set(["", "Interviewer session"]);

/** True when the session still carries a placeholder title — i.e. the model
 *  may auto-name it, and the user hasn't chosen a name yet. */
export function isDefaultSessionTitle(t: string | null | undefined): boolean {
  return DEFAULT_TITLES.has((t ?? "").trim());
}

function storedPersona(): Persona {
  return localStorage.getItem(PERSONA_KEY) === "interviewer" ? "interviewer" : "candidate";
}

interface TranscriptItem {
  id: string;
  sequenceNo: number;
  text: string;
  isFinal: boolean;
  confidence?: number | null;
  speaker?: "user" | "interviewer";
  /** STT engine that produced this segment — surfaced as a status chip. */
  source?: string;
}

interface InsightItem {
  id: string;
  type?: string;
  contentJson: Record<string, unknown>;
  createdAt: string;
}
export interface Notice {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

interface State {
  screen: Screen;
  persona: Persona;
  token: string | null;
  userId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  sessionStatus: string;
  /** Display title (null = untitled). Updated when the model auto-names or
   *  the user renames — screens read this instead of refetching. */
  sessionTitle: string | null;
  consentConfirmed: boolean;
  transcript: TranscriptItem[];
  insights: InsightItem[];
  stealth: StealthState;
  connected: boolean;
  /** True while the coach LLM is mid-generation (first token received). */
  coachWorking: boolean;
  error: string | null;
  notices: Notice[];

  setScreen(s: Screen): void;
  /** Context switch candidate ⇄ interviewer. No-op mid-live-session (returns
   *  false so the switch UI can flash a notice). */
  setPersona(p: Persona): boolean;
  setAuth(token: string, userId: string, workspaceId: string): void;
  /** Rotate just the token (sliding session renewal) — keeps identity/workspace. */
  setToken(token: string): void;
  clearAuth(): void;
  setSession(id: string | null, status?: string, title?: string | null): void;
  setConsent(v: boolean): void;
  pushTranscript(item: TranscriptItem): void;
  pushInsight(item: InsightItem): void;
  setStealth(s: StealthState): void;
  setConnected(v: boolean): void;
  setCoachWorking(v: boolean): void;
  setError(e: string | null): void;
  notify(kind: Notice["kind"], message: string): void;
  dismiss(id: string): void;
  resetLive(): void;
}

export const useStore = create<State>((set, get) => ({
  screen: "onboarding",
  persona: storedPersona(),
  token: localStorage.getItem(`${STORAGE_PREFIX}_token`),
  userId: localStorage.getItem(`${STORAGE_PREFIX}_userId`),
  workspaceId: localStorage.getItem(`${STORAGE_PREFIX}_workspaceId`),
  sessionId: null,
  sessionStatus: "draft",
  sessionTitle: null,
  consentConfirmed: false,
  transcript: [],
  insights: [],
  stealth: { captureExclusion: false, taskbarHidden: false, masquerade: "none", masqueradeTitle: null, enforcedAtMs: 0 },
  connected: false,
  coachWorking: false,
  error: null,
  notices: [],

  setScreen: (screen) => set({ screen }),
  setPersona: (persona) => {
    // Never strand a recording: an active live session pins the persona until
    // it ends. Everything else swaps context immediately.
    if (get().sessionStatus === "live") return false;
    localStorage.setItem(PERSONA_KEY, persona);
    set({ persona, screen: persona === "interviewer" ? "prep" : "home" });
    return true;
  },
  setAuth: (token, userId, workspaceId) => {
    localStorage.setItem(`${STORAGE_PREFIX}_token`, token);
    localStorage.setItem(`${STORAGE_PREFIX}_userId`, userId);
    localStorage.setItem(`${STORAGE_PREFIX}_workspaceId`, workspaceId);
    set({ token, userId, workspaceId });
  },
  clearAuth: () => {
    localStorage.removeItem(`${STORAGE_PREFIX}_token`);
    localStorage.removeItem(`${STORAGE_PREFIX}_userId`);
    localStorage.removeItem(`${STORAGE_PREFIX}_workspaceId`);
    set({ token: null, userId: null, workspaceId: null, screen: "onboarding" });
  },
  setToken: (newToken) => {
    localStorage.setItem(`${STORAGE_PREFIX}_token`, newToken);
    set({ token: newToken });
  },
  setSession: (sessionId, sessionStatus, sessionTitle) => set({
    sessionId,
    ...(sessionStatus ? { sessionStatus } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle } : {}),
  }),
  setConsent: (consentConfirmed) => set({ consentConfirmed }),
  pushTranscript: (item) =>
    set((s) => {
      // Dictation UX: a partial updates its existing line in place (stable
      // per-utterance id from the server); a final commits it. No row churn —
      // one line per utterance, like a voice-typing keyboard.
      const idx = s.transcript.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        const next = s.transcript.slice();
        next[idx] = item;
        return { transcript: next };
      }
      return { transcript: [...s.transcript, item].slice(-300) };
    }),
  pushInsight: (item) => set((s) => ({ insights: [...s.insights, item].slice(-50) })),
  setStealth: (stealth) => set({ stealth }),
  setConnected: (connected) => set({ connected }),
  setCoachWorking: (coachWorking) => set({ coachWorking }),
  setError: (error) => set({ error }),
  notify: (kind, message) =>
    set((s) => ({
      notices: [...s.notices, { id: Math.random().toString(36).slice(2), kind, message }].slice(-4),
    })),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  resetLive: () => set({ transcript: [], insights: [], sessionStatus: "draft", sessionTitle: null, connected: false }),
}));
