/**
 * App-level overlay forwarding — runs once at startup, outside React, so the
 * stealth overlay receives live transcript and coach responses no matter
 * which screen is active. Component-scoped forwarding (the old approach) went
 * deaf whenever the user toggled the overlay from Home/Settings/Review.
 *
 * Delivery routes through the Rust `overlay_emit` command: JS-to-JS
 * cross-webview emit is the least reliable path; the Rust emitter provably
 * reaches the overlay (visibility/toggle events work through it today).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../state/store";

let lastTranscriptId: string | null = null;
let lastInsightId: string | null = null;
let unlistenReady: (() => void) | null = null;

/** Rust-emitter broadcast — the proven event path into the overlay. */
function overlayEmit(event: string, payload: unknown): void {
  void invoke("overlay_emit", { event, payload }).catch(() => {
    // Overlay window not created yet (or Rust unavailable) — drop silently;
    // the overlay backfills from the store when it announces ready.
  });
}

/** Backfill a freshly opened overlay with the current tail of the session. */
async function backfill(): Promise<void> {
  const { transcript, insights } = useStore.getState();
  for (const t of transcript.slice(-4)) {
    overlayEmit("overlay://transcript", { id: t.id, speaker: t.speaker ?? null, text: t.text, isFinal: t.isFinal });
  }
  const ins = insights[insights.length - 1];
  if (ins) {
    overlayEmit("overlay://insight", { type: ins.type, contentJson: ins.contentJson });
  }
}

export function startOverlayForwarding(): void {
  useStore.subscribe((s) => {
    const t = s.transcript[s.transcript.length - 1];
    if (t && t.id !== lastTranscriptId) {
      lastTranscriptId = t.id;
      overlayEmit("overlay://transcript", { id: t.id, speaker: t.speaker ?? null, text: t.text, isFinal: t.isFinal });
    }
    const ins = s.insights[s.insights.length - 1];
    if (ins && ins.id !== lastInsightId) {
      lastInsightId = ins.id;
      // `type` rides along so the overlay can render each insight kind
      // (prepared answer / auto answer / coach framework) correctly.
      overlayEmit("overlay://insight", { type: ins.type, contentJson: ins.contentJson });
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
