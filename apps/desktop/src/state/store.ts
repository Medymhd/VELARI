import { create } from "zustand";
import { STORAGE_PREFIX } from "brand";
import type { StealthState } from "../lib/tauri";

export type Screen = string;
// Core screens always present; vertical-specific screens are any `work/*` `interview/*` etc.
// Adding a new vertical alongside the 2 built never edits this union — shell renders whatever
// the manifest registry returns via `/v1/verticals` (dynamic, see App.tsx + server.ts discoverVerticals).

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
  token: string | null;
  userId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  sessionStatus: string;
  consentConfirmed: boolean;
  transcript: TranscriptItem[];
  insights: InsightItem[];
  stealth: StealthState;
  connected: boolean;
  error: string | null;
  notices: Notice[];

  setScreen(s: Screen): void;
  setAuth(token: string, userId: string, workspaceId: string): void;
  clearAuth(): void;
  setSession(id: string | null, status?: string): void;
  setConsent(v: boolean): void;
  pushTranscript(item: TranscriptItem): void;
  pushInsight(item: InsightItem): void;
  setStealth(s: StealthState): void;
  setConnected(v: boolean): void;
  setError(e: string | null): void;
  notify(kind: Notice["kind"], message: string): void;
  dismiss(id: string): void;
  resetLive(): void;
}

export const useStore = create<State>((set) => ({
  screen: "onboarding",
  token: localStorage.getItem(`${STORAGE_PREFIX}_token`),
  userId: localStorage.getItem(`${STORAGE_PREFIX}_userId`),
  workspaceId: localStorage.getItem(`${STORAGE_PREFIX}_workspaceId`),
  sessionId: null,
  sessionStatus: "draft",
  consentConfirmed: false,
  transcript: [],
  insights: [],
  stealth: { captureExclusion: false, taskbarHidden: false, masquerade: "none", masqueradeTitle: null, enforcedAtMs: 0 },
  connected: false,
  error: null,
  notices: [],

  setScreen: (screen) => set({ screen }),
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
  setSession: (sessionId, sessionStatus) => set({ sessionId, ...(sessionStatus ? { sessionStatus } : {}) }),
  setConsent: (consentConfirmed) => set({ consentConfirmed }),
  pushTranscript: (item) => set((s) => ({ transcript: [...s.transcript, item].slice(-300) })),
  pushInsight: (item) => set((s) => ({ insights: [...s.insights, item].slice(-50) })),
  setStealth: (stealth) => set({ stealth }),
  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),
  notify: (kind, message) =>
    set((s) => ({
      notices: [...s.notices, { id: Math.random().toString(36).slice(2), kind, message }].slice(-4),
    })),
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  resetLive: () => set({ transcript: [], insights: [], sessionStatus: "draft", connected: false }),
}));
