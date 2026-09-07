/**
 * App-level overlay forwarding — runs once at startup, outside React, so the
 * stealth overlay receives live transcript and coach responses no matter
 * which screen is active. Component-scoped forwarding (the old approach) went
 * deaf whenever the user toggled the overlay from Home/Settings/Review.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { useStore } from "../state/store";

let lastTranscriptId: string | null = null;
let lastInsightId: string | null = null;
let unlistenReady: (() => void) | null = null;

/** Backfill a freshly opened overlay with the current tail of the session. */
async function backfill(): Promise<void> {
  const { transcript, insights } = useStore.getState();
  for (const t of transcript.slice(-4)) {
    void emit("overlay://transcript", { id: t.id, speaker: t.speaker ?? null, text: t.text, isFinal: t.isFinal });
  }
  const ins = insights[insights.length - 1];
  if (ins) {
    void emit("overlay://insight", { type: ins.type, contentJson: ins.contentJson });
  }
}

export function startOverlayForwarding(): void {
  useStore.subscribe((s) => {
    const t = s.transcript[s.transcript.length - 1];
    if (t && t.id !== lastTranscriptId) {
      lastTranscriptId = t.id;
      void emit("overlay://transcript", { id: t.id, speaker: t.speaker ?? null, text: t.text, isFinal: t.isFinal });
    }
    const ins = s.insights[s.insights.length - 1];
    if (ins && ins.id !== lastInsightId) {
      lastInsightId = ins.id;
      // `type` rides along so the overlay can render each insight kind
      // (prepared answer / auto answer / coach framework) correctly.
      void emit("overlay://insight", { type: ins.type, contentJson: ins.contentJson });
    }
  });
  void listen("overlay://ready", () => void backfill()).then((u) => {
    unlistenReady = u;
  });
}

export function stopOverlayForwarding(): void {
  unlistenReady?.();
  unlistenReady = null;
}
