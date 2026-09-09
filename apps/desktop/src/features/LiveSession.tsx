import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore, isDefaultSessionTitle } from "../state/store";
import { stealthSetCapture, stealthSetMasquerade, stealthSetTaskbar, type MasqueradeProfile, type StealthState } from "../lib/tauri";
import { isTauri } from "../lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { emit, listen } from "@tauri-apps/api/event";
import {
  listenMicBatches,
  listenSystemBatches,
  listInputDevices,
  startMicCapture,
  startSystemCapture,
  stopMicCapture,
  stopSystemCapture,
  type NativeAudioBatch,
  type NativeAudioDevice,
} from "../lib/nativeAudio";
import { RelayDirectStream, resolveRelaySession } from "../lib/relayStt";
import { StatusPill, Toggle } from "@app/ui";
import InterviewerPanel from "./InterviewerPanel";

const nativeAvailable = isTauri();

/** Mode personas — must mirror the server's INTERVIEW_MODES (modes.ts). */
const MODES: { id: string; label: string }[] = [
  { id: "general", label: "General" },
  { id: "job-seeker", label: "Looking for work" },
  { id: "technical", label: "Technical interview" },
  { id: "sales", label: "Sales call" },
  { id: "recruiting", label: "Recruiting screen" },
  { id: "team-meet", label: "Team meeting" },
  { id: "lecture", label: "Lecture / class" },
  { id: "seminar", label: "Seminar / talk" },
  { id: "support", label: "Support / call center" },
];

/** Speakable-answer insight kinds — these sort above coach frameworks in the
 *  Coaching panel (answer-first, matching the stealth overlay). */
function isAnswerInsight(i: { type?: string }): boolean {
  return i.type === "auto_answer" || i.type === "prepared_answer" || i.type === "solver" || i.type === "suggested_answer_cached";
}

const TranscriptRow = memo(function TranscriptRow({ t }: { t: { id: string; sequenceNo: number; text: string; isFinal: boolean; confidence?: number | null; speaker?: string } }) {  const conf = t.confidence ?? 0;
  const confClass = conf >= 0.8 ? "conf-high" : conf >= 0.5 ? "conf-med" : conf > 0 ? "conf-low" : "";
  return (
    <div className={`seg-enter ${confClass} hud-scanlines`} style={{ opacity: t.isFinal ? 1 : 0.55, borderLeft: `2px solid ${t.isFinal ? "var(--accent)" : "var(--border)"}`, paddingLeft: 10, position: "relative" }}>
      <div style={{ fontSize: 13 }} className={t.isFinal ? "" : "char-appear"}>
        {t.speaker && <span className="small muted" style={{ marginRight: 6 }}>[{t.speaker === "user" ? "You" : "Interviewer"}]</span>}
        {t.text}
      </div>
      <div className="small muted">#{t.sequenceNo} {t.isFinal ? "final" : "partial"} {t.confidence ? `· ${(t.confidence * 100).toFixed(0)}%` : ""}</div>
      {t.confidence != null && <div className={`confidence-meter ${confClass.replace("conf-", "")}`}><div style={{ width: `${Math.round(conf * 100)}%` }} /></div>}
    </div>
  );
});

function base64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Chunked binary→base64 — `String.fromCharCode(...bytes)` on large native
 *  batches overflows the stack, so spread in 32 KB slices. */
function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** File → base64 (no data: prefix) for server-side extraction. */
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

function useRealtime(sessionId: string | null) {
  const { pushTranscript, pushInsight, setConnected, setError, notify, setCoachWorking } = useStore();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const sid = sessionId;
    let disposed = false;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let lastWarnCode = "";
    let lastWarnAt = 0;

    function clearTimers() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    }

    function handleMessage(ev: MessageEvent) {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; code?: string; message?: string; segment?: { id: string; sequenceNo: number; text: string; isFinal: boolean; confidence?: number; speaker?: string; source?: string }; insight?: { id: string; type?: string; contentJson: Record<string, unknown>; createdAt: string } };
        if (msg.type === "transcript.final" || msg.type === "transcript.partial") {
          const s = msg.segment!;
          pushTranscript({ id: s.id, sequenceNo: s.sequenceNo, text: s.text, isFinal: s.isFinal, confidence: s.confidence, speaker: s.speaker === "user" || s.speaker === "interviewer" ? s.speaker : undefined, source: s.source });
        } else if (msg.type === "coach.suggestion" && msg.insight) {
          pushInsight({ id: msg.insight.id, type: msg.insight.type, contentJson: msg.insight.contentJson, createdAt: msg.insight.createdAt });
          setCoachWorking(false);
        } else if (msg.type === "coach.working") {
          // First token from the coach — replace dead air with a live indicator.
          setCoachWorking(true);
        } else if (msg.type === "pipeline.warning" && msg.code && msg.code !== "pong" && msg.code !== "session_not_live") {
          // Surface backend trouble instead of swallowing it (throttled per code).
          const now = Date.now();
          if (msg.code !== lastWarnCode || now - lastWarnAt > 10_000) {
            lastWarnCode = msg.code;
            lastWarnAt = now;
            notify("error", `Realtime: ${msg.code} — ${msg.message ?? "see API logs"}`);
          }
        }
      } catch { /* ignore */ }
    }

    function scheduleRetry() {
      if (disposed) return;
      setConnected(false);
      retryTimer = setTimeout(() => {
        retryMs = Math.min(retryMs * 2, 15_000);
        connect();
      }, retryMs);
    }

    function connect() {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(api.wsUrl(sid));
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retryMs = 1000;
        setConnected(true);
        // Heartbeat: server answers with a pong warning frame; keeps NATs,
        // proxies and idle-timeout heuristics from reaping the socket.
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", eventId: Math.random().toString(36).slice(2) }));
          }
        }, 15_000);
      };
      ws.onclose = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (!disposed) scheduleRetry();
      };
      ws.onerror = () => setError("realtime connection failed");
      ws.onmessage = handleMessage;
    }

    connect();
    return () => {
      disposed = true;
      clearTimers();
      wsRef.current?.close();
    };
  }, [sessionId, pushInsight, pushTranscript, setConnected, setError, notify, setCoachWorking]);

  return wsRef;
}

export default function LiveSession() {
  const { sessionId, sessionStatus, sessionTitle, transcript, insights, connected, workspaceId, pushTranscript, pushInsight, setSession, stealth, setStealth, consentConfirmed, setConsent, notify, coachWorking, persona } = useStore();
  const [busy, setBusy] = useState(false);
  const [stealthBusy, setStealthBusy] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [visionAnswer, setVisionAnswer] = useState<string | null>(null);
  const wsRef = useRealtime(sessionId);
  // Late-bound hook so effects declared before sendClientFinal can reach it.
  const sendClientFinalRef = useRef<((text: string, confidence: number, source: "cloud_stt" | "imported") => void) | null>(null);

  // Hydration: opening a session loads its persisted transcript + insights
  // from the API, so reopening (even a completed one) continues in place.
  // resetLive() from Sessions guarantees we never append to another session's data.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(false);
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [segs, ins] = await Promise.all([
          api.transcript(sessionId).catch(() => []),
          api.insights(sessionId).catch(() => []),
        ]);
        if (cancelled) return;
        for (const s of segs) {
          pushTranscript({ id: s.id, sequenceNo: s.sequenceNo, text: s.text, isFinal: true, confidence: s.confidence ?? undefined, speaker: s.speaker === "user" || s.speaker === "interviewer" ? (s.speaker as "user" | "interviewer") : undefined });
        }
        for (const i of ins) {
          pushInsight({ id: i.id, type: i.type, contentJson: i.contentJson, createdAt: String(i.createdAt ?? new Date().toISOString()) });
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, pushTranscript, pushInsight]);

  // Model auto-naming: once a few finals exist and the session still carries
  // a placeholder title, the model names it from CV/JD + opening transcript
  // (user-typed names are never touched). Once per session, silent on failure.
  const titledRef = useRef<string | null>(null);
  const finalCount = transcript.filter((t) => t.isFinal).length;
  useEffect(() => {
    if (!sessionId || !workspaceId) return;
    if (titledRef.current === sessionId) return;
    if (finalCount < 3) return;
    if (!isDefaultSessionTitle(sessionTitle)) { titledRef.current = sessionId; return; }
    titledRef.current = sessionId;
    void (async () => {
      try {
        const res = await api.verticalPost<{ title: string }>(
          "interview-intelligence", "/session/suggest-title", { workspaceId, sessionId },
        );
        if (!res.title) return;
        await api.patchSession(sessionId, { title: res.title });
        setSession(sessionId, undefined, res.title);
        notify("success", `Named "${res.title}" — rename anytime`);
      } catch { /* best-effort */ }
    })();
  }, [sessionId, workspaceId, finalCount, sessionTitle, setSession, notify]);

  // Browser-companion capture (rival Ctrl+Y parity): poll for web contexts
  // captured via the extension and drop them into the transcript as notes.
  const lastContextAt = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !connected) return;
    const poll = setInterval(async () => {
      try {
        const rows = await api.fetchWebContext(lastContextAt.current ?? undefined);
        for (const row of rows) {
          lastContextAt.current = row.createdAt;
          const label = row.contentJson.title || row.contentJson.url || "captured page";
          const text = `[web] ${label}: ${(row.contentJson.text ?? "").slice(0, 300)}`;
          pushTranscript({ id: row.id, sequenceNo: Date.now(), text, isFinal: true, speaker: "user" });
          sendClientFinalRef.current?.(text, 0.9, "imported");
        }
      } catch { /* polling is best-effort */ }
    }, 10_000);
    return () => clearInterval(poll);
  }, [sessionId, connected]);

  // Audio capture -> WS audio.chunk (AudioWorklet primary, ScriptProcessor fallback)
  const audioRef = useRef<{ ctx: AudioContext; node: AudioWorkletNode | null; proc: ScriptProcessorNode | null; stream: MediaStream } | null>(null);

  // Native (Rust) capture — per-channel live-apply: toggling a checkbox
  // starts/stops the Rust DSP immediately, no session restart needed.
  const [nativeMic, setNativeMic] = useState(false);
  const [nativeSystem, setNativeSystem] = useState(false);
  const [micDevices, setMicDevices] = useState<NativeAudioDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("default");
  const nativeUnlisten = useRef<{ mic?: UnlistenFn; system?: UnlistenFn }>({});
  const nativeStarting = useRef<{ mic: boolean; system: boolean }>({ mic: false, system: false });

  // Direct relay fallback (§5.1.5): native audio → STT relay when the
  // realtime WS is down; finals replay to the session on reconnect.
  const relayRef = useRef<RelayDirectStream | null>(null);
  const [relayActive, setRelayActive] = useState(false);
  const pendingClientFinals = useRef<Record<string, unknown>[]>([]);
  const clientFinalSeq = useRef(0);
  const relayLastAttemptMs = useRef(0);

  // Stealth overlay: forward the live session into the always-on-top panel.
const [overlayOn, setOverlayOn] = useState(false);

  // Mode persona — pushed to the server on change; overlay-mode state.
  const [mode, setMode] = useState("general");
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "session.mode", eventId: Math.random().toString(36).slice(2), mode }));
    }
  }, [mode, connected]);

  // Response length — short/medium/long budget, pushed to the server on change.
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "session.length", eventId: Math.random().toString(36).slice(2), length }));
    }
  }, [length, connected]);

  // Audio watchdog — reference "0 chunks in 12s" banner parity: a capture toggle
  // that is ON but receives no audio for 12s means a dead/busy device.
  const lastNativeBatchAt = useRef<{ mic: number; system: number }>({ mic: 0, system: 0 });
  const watchdogWarned = useRef<{ mic: boolean; system: boolean }>({ mic: false, system: false });
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      if (nativeMic && lastNativeBatchAt.current.mic > 0 && now - lastNativeBatchAt.current.mic > 12_000 && !watchdogWarned.current.mic) {
        watchdogWarned.current.mic = true;
        notify("error", "Microphone capture silent for 12s — check the device or permissions.");
      }
      if (nativeSystem && lastNativeBatchAt.current.system > 0 && now - lastNativeBatchAt.current.system > 12_000 && !watchdogWarned.current.system) {
        watchdogWarned.current.system = true;
        notify("error", "System audio silent for 12s — is anything playing?");
      }
    }, 5_000);
    return () => clearInterval(t);
  }, [nativeMic, nativeSystem]);

  // Clear large screenshot data when session changes to free memory
  useEffect(() => {
    return () => setShot(null);
  }, [sessionId]);

  useEffect(() => {
    if (nativeAvailable) void listInputDevices().then(setMicDevices).catch(() => {});
    if (!nativeAvailable) return;
    let un: UnlistenFn | null = null;
    void listen("cropper://captured", (e) => {
      const payload = e.payload as { dataB64: string };
      setShot(`data:image/png;base64,${payload.dataB64}`);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  function forwardRelayFinal(text: string, confidence: number) {
    sendClientFinal(text, confidence, "cloud_stt");
  }

  function sendClientFinal(text: string, confidence: number, source: "cloud_stt" | "imported") {
    const frame = {
      type: "transcript.client_final",
      eventId: Math.random().toString(36).slice(2),
      sequenceNo: Date.now(),
      occurredAt: new Date().toISOString(),
      segment: {
        sequenceNo: ++clientFinalSeq.current,
        startedAtMs: Date.now(),
        endedAtMs: Date.now(),
        text,
        confidence,
        isFinal: true,
        source,
      },
    };
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(frame));
    else {
      if (pendingClientFinals.current.length >= 100) pendingClientFinals.current.shift();
      pendingClientFinals.current.push(frame);
    }
  }
  sendClientFinalRef.current = sendClientFinal;

  // Replay finals captured while the realtime WS was down.
  useEffect(() => {
    if (!connected) return;
    for (const frame of pendingClientFinals.current.splice(0)) {
      wsRef.current?.send(JSON.stringify(frame));
    }
  }, [connected]);

  // Written asks from the stealth overlay ("Ask"/"Solve" input). The overlay
  // now routes through the RUST emitter (overlay_emit command) — JS-to-JS
  // cross-webview emit silently drops messages in the field, which is why
  // asks could get stuck on the overlay with the coach never reacting.
  useEffect(() => {
    if (!nativeAvailable) return;
    let un: UnlistenFn | null = null;
    void listen<{ text: string; mode?: "ask" | "solve" }>("overlay://user_ask", (e) => {
      const text = (e.payload?.text ?? "").trim();
      if (!text || !sessionId) return;
      const solve = e.payload?.mode === "solve";
      const frame = {
        type: solve ? "coach.solve" : "coach.ask",
        eventId: Math.random().toString(36).slice(2),
        sequenceNo: Date.now(),
        occurredAt: new Date().toISOString(),
        text,
      };
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(frame));
      else notify("error", "Realtime not connected — cannot send the ask");
    }).then((u) => (un = u));
    return () => un?.();
  }, [nativeAvailable, sessionId, notify]);

  // Stealth overlay forwarding is app-level now (lib/overlayForward.ts) —
  // it works from every screen and backfills the panel when it opens.

  useEffect(() => {
    if (!nativeAvailable) return;
    let un: UnlistenFn | null = null;
    void listen<{ text: string }>("overlay://manual", (e) => {
      const text = e.payload.text.trim();
      if (!text || !sessionId) return;
      pushTranscript({ id: `note-${Math.random().toString(36).slice(2)}`, sequenceNo: Date.now(), text, isFinal: true, speaker: "user" });
      sendClientFinal(text, 1, "imported");
    }).then((u) => (un = u));
    return () => un?.();
  }, [nativeAvailable, sessionId]);

  // Global chords Ctrl+Shift+O (overlay) and Ctrl+Shift+H (app) are handled
  // authoritatively in Rust — they work on every screen and check real window
  // visibility. Here we only register Ctrl+Shift+B (passthrough) and
  // Ctrl+Shift+P (position cycle), and keep the checkbox in sync with the
  // overlay's true visibility.
  const overlayOnRef = useRef(false);
  const passthroughRef = useRef(false);
  useEffect(() => {
    if (!nativeAvailable) return;
    // Ctrl+Shift+B is registered and dispatched Rust-side (works on every
    // screen) — LiveSession only mirrors the state here for the UI.
    invoke("register_global_chord", { chord: "Ctrl+Shift+P", action: "overlay-cycle-position" }).catch((e) =>
      console.warn("global chord unavailable", e),
    );
    let unVis: UnlistenFn | null = null;
    void listen<boolean>("overlay://visibility", (e) => {
      overlayOnRef.current = e.payload;
      setOverlayOn(e.payload);
    }).then((u) => (unVis = u));
    let un: UnlistenFn | null = null;
    void listen("chord://activated", (e) => {
      const action = (e.payload as { action?: string }).action ?? "";
      if (action === "overlay-cycle-position") {
        if (!overlayOnRef.current) return;
        void invoke<string>("overlay_cycle_position", { verticalId: "interview-intelligence" })
          .then((spot) => notify("info", `Overlay position: ${spot} (Ctrl+Shift+P to cycle)`))
          .catch((err) => notify("error", `Position cycle failed: ${errText(err)}`));
      }
    }).then((u) => (un = u));
    // The overlay's ● button also toggles passthrough — keep the chord's
    // state mirror in sync so Ctrl+Shift+B never computes from a stale value
    // (the "sometimes reversed" feel).
    let unPt: UnlistenFn | null = null;
    void listen<boolean>("overlay://passthrough", (e) => {
      passthroughRef.current = e.payload === true;
    }).then((u) => (unPt = u));
    return () => {
      un?.();
      unVis?.();
      unPt?.();
    };
  }, [nativeAvailable]);

  async function toggleOverlay(on: boolean) {
    // Route through the same authoritative toggle so the checkbox, the
    // global chord and the X button can never disagree. Backfill on open is
    // handled by the overlay itself (overlay://ready → app-level forwarder).
    try {
      const visible = await invoke<boolean>("overlay_toggle", { verticalId: "interview-intelligence" });
      if (on !== visible) {
        // Desired state differs from post-toggle reality (e.g. X pressed
        // between) — force it once more.
        await invoke<boolean>("overlay_toggle", { verticalId: "interview-intelligence" });
      }
    } catch (e) {
      console.warn("overlay failed", e);
      overlayOnRef.current = false;
      setOverlayOn(false);
      notify("error", `Overlay failed: ${errText(e)}`);
    }
  }

  async function activateRelayDirect() {
    if (!workspaceId || relayRef.current) return;
    if (Date.now() - relayLastAttemptMs.current < 30_000) return;
    relayLastAttemptMs.current = Date.now();
    try {
      const resolved = await resolveRelaySession(workspaceId);
      relayRef.current = new RelayDirectStream({
        url: resolved.relayWsUrl,
        token: resolved.sessionToken,
        onPartial: (text) =>
          pushTranscript({
            id: `relay-p-${Math.random().toString(36).slice(2)}`,
            sequenceNo: Date.now(),
            text,
            isFinal: false,
          }),
        onFinal: forwardRelayFinal,
        onClose: () => setRelayActive(false),
      });
      setRelayActive(true);
    } catch (e) {
      console.warn("direct relay unavailable", e);
    }
  }

  function stopRelayDirect() {
    relayRef.current?.close();
    relayRef.current = null;
    setRelayActive(false);
  }

  // Activate when live with native capture but no realtime connection.
  useEffect(() => {
    if (sessionStatus === "live" && !connected && nativeAvailable && (nativeMic || nativeSystem)) {
      void activateRelayDirect();
    }
  }, [sessionStatus, connected, nativeMic, nativeSystem, workspaceId]);

  function sendPcm(pcm: Int16Array, channel?: "mic" | "system") {
    const b64 = pcmToBase64(pcm);
    const frame = JSON.stringify({
      type: "audio.chunk",
      eventId: Math.random().toString(36).slice(2),
      sequenceNo: Date.now(),
      occurredAt: new Date().toISOString(),
      payloadB64: b64,
      format: "pcm_s16le_16k",
      ...(channel ? { channel } : {}),
    });
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(frame);
  }

  function forwardNativeBatch(batch: NativeAudioBatch) {
    try {
      lastNativeBatchAt.current[batch.channel] = Date.now();
      watchdogWarned.current[batch.channel] = false;
      // Native batch is already 16kHz PCM base64 — forward without decode/re-encode
      const frame = JSON.stringify({
        type: "audio.chunk",
        eventId: Math.random().toString(36).slice(2),
        sequenceNo: Date.now(),
        occurredAt: new Date().toISOString(),
        payloadB64: batch.dataB64,
        format: "pcm_s16le_16k",
        channel: batch.channel,
      });
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(frame);
      // Relay needs raw PCM bytes
      try {
        const pcm = base64ToPcm(batch.dataB64);
        relayRef.current?.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      } catch {}
    } catch (e) {
      console.warn("native batch forward failed", e);
    }
  }

  async function startNativeChannel(channel: "mic" | "system") {
    if (!nativeAvailable || nativeUnlisten.current[channel] || nativeStarting.current[channel]) return;
    nativeStarting.current[channel] = true;
    try {
      if (channel === "mic") {
        const info = await startMicCapture(micDeviceId === "default" ? undefined : micDeviceId);
        console.info("native mic capture started", info);
        nativeUnlisten.current.mic = await listenMicBatches(forwardNativeBatch);
      } else {
        const info = await startSystemCapture();
        console.info("native system capture started", info);
        nativeUnlisten.current.system = await listenSystemBatches(forwardNativeBatch);
      }
    } finally {
      nativeStarting.current[channel] = false;
    }
  }

  async function stopNativeChannel(channel: "mic" | "system") {
    nativeUnlisten.current[channel]?.();
    if (channel === "mic") nativeUnlisten.current.mic = undefined;
    else nativeUnlisten.current.system = undefined;
    if (!nativeAvailable) return;
    try {
      if (channel === "mic") await stopMicCapture();
      else await stopSystemCapture();
    } catch { /* already stopped */ }
  }

  async function stopAllNativeCapture() {
    await stopNativeChannel("mic");
    await stopNativeChannel("system");
  }

  async function toggleNativeMic(on: boolean) {
    setNativeMic(on);
    try {
      if (on) await startNativeChannel("mic");
      else await stopNativeChannel("mic");
    } catch (e) {
      setNativeMic(!on);
      notify("error", `Mic capture failed: ${errText(e)}`);
    }
  }

  async function toggleNativeSystem(on: boolean) {
    setNativeSystem(on);
    try {
      if (on) await startNativeChannel("system");
      else await stopNativeChannel("system");
    } catch (e) {
      setNativeSystem(!on);
      notify("error", `System capture failed: ${errText(e)}`);
    }
  }

  async function startCapture() {
    if (!sessionId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (audioRef.current) stopCapture();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext({ sampleRate: 16000 });
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);

      // Try AudioWorklet first (modern, low-latency)
      try {
        await ctx.audioWorklet.addModule(new URL("../worklets/pcm-capture.worklet.js", import.meta.url));
        const node = new AudioWorkletNode(ctx, "pcm-capture");
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          const pcm = new Int16Array(ev.data as ArrayBuffer);
          sendPcm(pcm);
        };
        src.connect(node);
        // Worklet does not need to connect to destination (avoids feedback)
        audioRef.current = { ctx, node, proc: null, stream };
        return;
      } catch (workletErr) {
        console.warn("AudioWorklet failed, falling back to ScriptProcessor", workletErr);
      }

      const proc = ctx.createScriptProcessor(4096, 1, 1);
      src.connect(proc);
      proc.connect(ctx.destination);
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i]!)) * 0x7fff;
        sendPcm(pcm);
      };
      audioRef.current = { ctx, node: null, proc, stream };
    } catch (ex) {
      notify("error", `Microphone capture failed: ${errText(ex)} — check the app's mic permission`);
    }
  }

  function stopCapture() {
    const cur = audioRef.current;
    if (!cur) return;
    try {
      cur.node?.disconnect();
    } catch {}
    try {
      cur.proc?.disconnect();
    } catch {}
    cur.ctx.close().catch(() => {});
    cur.stream.getTracks().forEach((t) => t.stop());
    audioRef.current = null;
  }

  useEffect(() => () => { stopCapture(); void stopAllNativeCapture(); stopRelayDirect(); }, []);

  async function act(action: "start" | "pause" | "complete") {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.sessionAction(sessionId, action);
      const next = action === "start" ? "live" : action === "pause" ? "paused" : "completed";
      setSession(sessionId, next);
      if (action === "start") {
        // Browser mic only when the native mic isn't handling it — running
        // both double-captures the same input (unlabeled duplicates).
        if (!(nativeAvailable && nativeMic)) void startCapture();
        // Reconcile: any checked native channel starts live here too.
        if (nativeAvailable) {
          if (nativeMic) void startNativeChannel("mic").catch((e) => notify("error", `Mic capture failed: ${errText(e)}`));
          if (nativeSystem) void startNativeChannel("system").catch((e) => notify("error", `System capture failed: ${errText(e)}`));
        }
      }
      if (action === "complete" || action === "pause") {
        stopCapture();
        void stopAllNativeCapture();
        stopRelayDirect();
      }
    } catch (e) {
      notify("error", `Session ${action} failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleCapture(on: boolean) {
    setStealthBusy("capture");
    try {
      const s = await stealthSetCapture(on);
      setStealth(s);
    } catch (e) {
      notify("error", `Capture exclusion failed: ${errText(e)}`);
    } finally {
      setStealthBusy(null);
    }
  }

  async function toggleTaskbar(on: boolean) {
    setStealthBusy("taskbar");
    try {
      const s = await stealthSetTaskbar(on);
      setStealth(s);
    } catch (e) {
      notify("error", `Taskbar hiding failed: ${errText(e)}`);
    } finally {
      setStealthBusy(null);
    }
  }

  async function setMasqueradeProfile(profile: MasqueradeProfile) {
    setStealthBusy("masquerade");
    try {
      const s = await stealthSetMasquerade(profile);
      setStealth(s);
    } catch (e) {
      notify("error", `Masquerade failed: ${errText(e)}`);
    } finally {
      setStealthBusy(null);
    }
  }

  async function enableStealthForAllBrowsersAndApps() {
    setStealthBusy("universal");
    try {
      const s = await invoke<StealthState>("stealth_enable_for_all_browsers_and_apps");
      setStealth(s);
    } catch (e) {
      notify("error", `Universal stealth failed: ${errText(e)}`);
    } finally {
      setStealthBusy(null);
    }
  }

  async function solveWithVision() {
    if (!shot || !sessionId) return;
    setBusy(true);
    setVisionAnswer(null);
    setCodeRun(null);
    try {
      const res = await api.visionSolve({
        sessionId,
        prompt: "Read the problem on screen. Give a concise solution approach with the key steps.",
        images: [{ base64: shot.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" }],
      });
      setVisionAnswer(res.text || "(empty response)");
    } catch (e) {
      notify("error", `Vision failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Verified code execution (rival codeVerification parity): extract the
   *  first fenced block from the vision answer and run it via /code/verify. */
  const [codeRun, setCodeRun] = useState<string | "busy" | null>(null);
  async function runVisionCode() {
    if (!visionAnswer) return;
    setCodeRun("busy");
    try {
      const fence = visionAnswer.match(/```(\w+)?\n([\s\S]*?)```/);
      if (!fence) { setCodeRun("No fenced code block found in the answer."); return; }
      const language = (fence[1] ?? "python").toLowerCase();
      const res = await api.codeVerify({ language, code: fence[2]! });
      setCodeRun(
        res.ok
          ? `OK\n${res.stdout ?? "(no output)"}`
          : `FAILED${res.error ? ` (${res.error})` : ""}\n${res.compileError ?? res.stderr ?? ""}`,
      );
    } catch (e) {
      setCodeRun(`failed: ${errText(e)}`);
    }
  }

  // STT engine visibility: the transcript frames carry the producing engine's
  // source — surface it so "demo" vs real transcription is never a mystery.
  const badgeSource = (() => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const s = transcript[i]?.source;
      if (s) return s;
    }
    return undefined;
  })();

  // Session prep (CV / job description / notes / drilled Q&As) — the rival's
  // biggest advantage: answers grounded in materials the user uploaded before
  // the interview. Q&A entries surface instantly via prepared-answer recall.
  type CtxRow = { id: string; kind: string; title: string; content: string };
  const [contexts, setContexts] = useState<CtxRow[]>([]);
  const [prepKind, setPrepKind] = useState("jd");
  const [prepTitle, setPrepTitle] = useState("");
  const [prepText, setPrepText] = useState("");
  const [prepBusy, setPrepBusy] = useState(false);

  const refreshContexts = useCallback(async () => {
    if (!sessionId) return;
    try { setContexts(await api.sessionContexts(sessionId)); } catch { /* best-effort */ }
  }, [sessionId]);
  useEffect(() => { void refreshContexts(); }, [refreshContexts]);

  async function addPrep() {
    if (!sessionId || (!prepText.trim())) return;
    setPrepBusy(true);
    try {
      await api.addSessionContext(sessionId, { kind: prepKind, title: prepTitle.trim() || undefined, content: prepText.trim() });
      setPrepText("");
      setPrepTitle("");
      notify("success", `Added ${prepKind.toUpperCase()} — the coach now uses it`);
      void refreshContexts();
      wsRef.current?.readyState === WebSocket.OPEN &&
        wsRef.current.send(JSON.stringify({ type: "session.reload_contexts", eventId: Math.random().toString(36).slice(2) }));
    } catch (e) {
      notify("error", `Add failed: ${errText(e)}`);
    } finally {
      setPrepBusy(false);
    }
  }

  async function addPrepFiles(files: FileList | null) {
    if (!sessionId || !files || files.length === 0) return;
    setPrepBusy(true);
    try {
      const payload = await Promise.all(
        Array.from(files).map(async (f) => ({ name: f.name, base64: await fileToBase64(f) })),
      );
      await api.addSessionContext(sessionId, { kind: prepKind, files: payload });
      notify("success", `Added ${payload.length} file(s) — text extracted server-side`);
      void refreshContexts();
      wsRef.current?.readyState === WebSocket.OPEN &&
        wsRef.current.send(JSON.stringify({ type: "session.reload_contexts", eventId: Math.random().toString(36).slice(2) }));
    } catch (e) {
      notify("error", `Upload failed: ${errText(e)}`);
    } finally {
      setPrepBusy(false);
    }
  }

  async function removePrep(ctxId: string) {
    if (!sessionId) return;
    try {
      await api.deleteSessionContext(sessionId, ctxId);
      setContexts((c) => c.filter((x) => x.id !== ctxId));
    } catch (e) {
      notify("error", `Delete failed: ${errText(e)}`);
    }
  }

  if (!sessionId) return <div className="card muted">Select or create a session from Sessions.</div>;

  return (
    <div className="grid" style={{ gridTemplateColumns: "1.2fr 0.8fr", alignItems: "start" }}>
      <div className="grid">
        <div className="card row hud-scanlines" style={{ justifyContent: "space-between", flexWrap: "wrap", rowGap: 8 }}>
          <div className="row" style={{ flexWrap: "wrap", rowGap: 6 }}>
            <span className="dot" style={{ background: connected ? "var(--success)" : "var(--muted)" }} />
            {connected && <div className="waveform"><span></span><span></span><span></span><span></span><span></span></div>}
            <StatusPill status={sessionStatus} />
            <span className="badge">{connected ? "realtime connected" : "offline"}</span>
            {relayActive && <span className="badge warn">direct relay</span>}
            {overlayOn && <span className="badge accent">overlay live</span>}
            {badgeSource && (
              <span className={`badge ${badgeSource === "simulated" ? "danger" : ""}`} title={`Engine: ${badgeSource}`}>
                STT: {badgeSource === "simulated" ? "DEMO" : badgeSource === "local_stt" ? "local" : badgeSource === "cloud_stt" ? "cloud" : badgeSource}
              </span>
            )}
            {!consentConfirmed && <span className="badge warn">consent required</span>}
          </div>
          <div className="row" style={{ flexWrap: "wrap", rowGap: 6 }}>
            <button disabled={busy || !consentConfirmed || !(sessionStatus === "draft" || sessionStatus === "paused" || sessionStatus === "completed")} onClick={() => void act("start")}>{busy && sessionStatus !== "live" ? "Starting…" : sessionStatus === "completed" ? "Reopen session" : "Start"}</button>
            <button disabled={busy || sessionStatus !== "live"} onClick={() => void act("pause")}>Pause</button>
            <button disabled={busy || !(sessionStatus === "live" || sessionStatus === "paused")} className="primary" onClick={() => void act("complete")}>{busy && sessionStatus === "live" ? "Completing…" : "Complete"}</button>
            {sessionStatus === "completed" && <span className="small muted" style={{ alignSelf: "center" }}>Completed — transcript below. Reopen to continue capture and coaching.</span>}
          </div>
        </div>

        <Toggle checked={consentConfirmed} onChange={setConsent} label="I have consent to record and process this session." />

        {useMemo(() => {
          const userCount = transcript.filter((t) => t.speaker === "user").length;
          const ivCount = transcript.filter((t) => t.speaker === "interviewer").length;
          const total = userCount + ivCount;
          if (total === 0) return null;
          const userPct = Math.round((userCount / total) * 100);
          return (
            <div className="col" style={{ gap: 4 }}>
              <div className="speaker-bar">
                <div className="seg user" style={{ width: `${userPct}%` }} />
                <div className="seg interviewer" style={{ width: `${100 - userPct}%` }} />
              </div>
              <div className="row small muted" style={{ justifyContent: "space-between" }}>
                <span>You {userPct}%</span>
                <span>{persona === "interviewer" ? "Candidate" : "Interviewer"} {100 - userPct}%</span>
              </div>
            </div>
          );
        }, [transcript])}

        <div className="card stagger">
          <span className="kicker" style={{ marginBottom: 8, display: "block" }}>Transcript — finals are persisted, partials are ephemeral</span>
          <div className="scroll grid" style={{ gap: 8, contain: "content" }}>
            {transcript.length === 0 && <span className="small muted">No transcript yet. Start the session and speak.</span>}
            {useMemo(() => transcript.slice(-80).map((t) => <TranscriptRow key={t.id} t={t} />), [transcript])}
          </div>
        </div>
      </div>

      <div className="grid">
        {persona === "interviewer" ? (
          <InterviewerPanel />
        ) : (
          <div className="card grid">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="kicker">Coaching</span>
            <span className="row" style={{ gap: 6 }}>
              <select
                value={length}
                onChange={(e) => setLength(e.target.value as "short" | "medium" | "long")}
                style={{ maxWidth: 110, fontSize: 12 }}
                title="Response length budget — how long spoken answers should be"
              >
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                style={{ maxWidth: 170, fontSize: 12 }}
                title="Mode persona — reshapes coaching and answer style"
              >
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </span>
          </div>
          {coachWorking && (
            <span className="badge accent" title="The coach heard the question and is crafting the answer.">
              <span className="spinner" style={{ marginRight: 6 }} /> crafting answer…
            </span>
          )}
          {insights.length === 0 && !coachWorking && <span className="small muted">Suggestions appear here after transcript activity.</span>}
          {/* Ring system: green = newest response, yellow = low STT confidence
              (question may be misheard), blue = everything else. Answer-first
              ordering: the speakable draft rides above the coach framework,
              matching the stealth overlay. */}
          {[...insights.slice(-6)]
            .reverse()
            .sort((a, b) => Number(isAnswerInsight(b)) - Number(isAnswerInsight(a)))
            .map((ins, idx) => {
            const isNewest = idx === 0;
            const lowConf = typeof ins.contentJson.stt_confidence === "number" && (ins.contentJson.stt_confidence as number) < 0.7;
            const ring = isNewest ? "var(--success)" : lowConf ? "#fbbf24" : "var(--accent)";
            const cardStyle = { background: "var(--surface-2)", borderColor: ring, borderWidth: 2 };
            return ins.type === "solver" ? (
              <div key={ins.id} className="card insight-arrive" style={cardStyle}>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  Solved — {String(ins.contentJson.question ?? "").slice(0, 120)}
                  {ins.contentJson.offline === true && (
                    <span className="badge" style={{ marginLeft: 8, color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }} title="The LLM call failed — nothing usable came back.">
                      LLM unavailable
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{String(ins.contentJson.answer ?? "")}</div>
                {overlayOn && (
                  <button className="ghost" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => void emit("overlay://insight", { type: "solver", contentJson: ins.contentJson })}>
                    Send to overlay
                  </button>
                )}
              </div>
            ) : ins.type === "prepared_answer" ? (
              <div key={ins.id} className="card insight-arrive" style={cardStyle}>
                <div className="small muted" style={{ marginBottom: 4 }}>
                  Prepared answer ({Math.round(Number(ins.contentJson.score ?? 0) * 100)}% match) — {String(ins.contentJson.title ?? "")}
                  {ins.contentJson.cached === true && <span className="badge" style={{ marginLeft: 8 }} title="Served from the answer cache — no LLM call.">cached</span>}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{String(ins.contentJson.answer ?? "")}</div>
                {ins.contentJson.cached === true && typeof ins.contentJson.cached_question === "string" && ins.contentJson.cached_question !== ins.contentJson.answer && (
                  <div className="small muted" style={{ marginTop: 4 }}>answered as: {String(ins.contentJson.cached_question)}</div>
                )}
                {overlayOn && (
                  <button className="ghost" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => void emit("overlay://insight", { contentJson: { talking_points: [String(ins.contentJson.answer ?? "")] } })}>
                    Send to overlay
                  </button>
                )}
              </div>
            ) : ins.type === "auto_answer" ? (
              <div key={ins.id} className="card insight-arrive" style={cardStyle}>
                <div className="small muted" style={{ marginBottom: 4 }}>Drafted answer — {String(ins.contentJson.question ?? "").slice(0, 120)}
                  {ins.contentJson.cached === true && <span className="badge" style={{ marginLeft: 8 }} title="Served from the answer cache — no LLM call.">cached</span>}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{String(ins.contentJson.answer ?? "")}</div>
                {typeof ins.contentJson.grounding === "string" && (ins.contentJson.grounding as string).trim() && (
                  <div
                    style={{
                      marginTop: 8, padding: "7px 10px", borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
                      background: "rgba(220, 20, 60, 0.08)", borderLeft: "2px solid rgba(220, 20, 60, 0.45)", color: "#b5566a",
                    }}
                    title="Extra CV-grounded example — use if the interviewer wants more"
                  >
                    {ins.contentJson.grounding as string}
                  </div>
                )}
                {overlayOn && (
                  <button className="ghost" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => void emit("overlay://insight", { contentJson: { talking_points: [String(ins.contentJson.answer ?? "")] } })}>
                    Send to overlay
                  </button>
                )}
              </div>
            ) : (
              <div key={ins.id} className="card insight-arrive" style={cardStyle}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {String(ins.contentJson.detected_question ?? "—")}
                  {lowConf && (
                    <span className="badge" style={{ marginLeft: 8, color: "#fbbf24", borderColor: "rgba(251,191,36,0.4)" }} title="The question was transcribed with low confidence — it may be misheard. Verify before speaking.">
                      low confidence — verify
                    </span>
                  )}
                  {ins.contentJson.cached === true && (
                    <span className="badge" style={{ marginLeft: 8 }} title="Served from the answer cache — no LLM call.">cached</span>
                  )}
                  {ins.contentJson.offline === true && (
                    <span className="badge" style={{ marginLeft: 8 }} title="LLM output was unusable — showing a structural scaffold instead.">
                      offline scaffold
                    </span>
                  )}
                </div>
                {ins.contentJson.cached === true && typeof ins.contentJson.cached_question === "string" && (
                  <div className="small muted" style={{ marginTop: 2 }}>answered as: {String(ins.contentJson.cached_question)}</div>
                )}
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                  {(ins.contentJson.suggested_outline as string[] | undefined)?.map((o: string) => <li key={o}>{o}</li>)}
                </ul>
                <div className="small muted" style={{ marginTop: 6 }}>{(ins.contentJson.talking_points as string[] | undefined)?.join(" · ")}</div>
              </div>
            );
          })}
          </div>
        )}

        <div className="card grid">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="kicker">Prep materials</span>
            <span className="small muted">{contexts.length} loaded</span>
          </div>
          <span className="small muted" style={{ margin: 0 }}>
            CV, job description, notes, drilled Q&As — the coach grounds every answer in these. Q&As surface instantly when the interviewer asks a matching question.
          </span>
          <div className="row" style={{ flexWrap: "wrap", rowGap: 6 }}>
            <select value={prepKind} onChange={(e) => setPrepKind(e.target.value)} style={{ maxWidth: 120 }}>
              <option value="jd">Job description</option>
              <option value="cv">CV / resume</option>
              <option value="notes">Notes</option>
              <option value="qa">Q&amp;A (Q: … A: …)</option>
            </select>
            <input placeholder="Title (optional)" value={prepTitle} onChange={(e) => setPrepTitle(e.target.value)} style={{ maxWidth: 140 }} />
          </div>
          <textarea
            rows={3}
            placeholder={prepKind === "qa" ? "Q: What is your greatest weakness?\nA: I used to over-polish deliverables…" : prepKind === "jd" ? "Paste the job description…" : "Paste text…"}
            value={prepText}
            onChange={(e) => setPrepText(e.target.value)}
          />
          <div className="row" style={{ flexWrap: "wrap", rowGap: 6 }}>
            <button className="primary" disabled={prepBusy || !prepText.trim()} onClick={() => void addPrep()}>
              {prepBusy ? "Working…" : "Add"}
            </button>
            <label className="ghost" style={{ cursor: "pointer", padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}>
              Upload pdf/docx/xlsx/txt
              <input type="file" accept=".pdf,.txt,.md,.docx,.xls,.xlsx,.csv" multiple style={{ display: "none" }} onChange={(e) => { void addPrepFiles(e.target.files); e.target.value = ""; }} />
            </label>
          </div>
          {contexts.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              {contexts.map((c) => (
                <div key={c.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="badge" style={{ marginRight: 6 }}>{c.kind.toUpperCase()}</span>
                    {c.title}
                    <span className="small muted" style={{ marginLeft: 6 }}>{(c.content.length / 1000).toFixed(1)}k chars</span>
                  </span>
                  <button className="ghost" onClick={() => void removePrep(c.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card grid">
          <span className="kicker">Native audio - Rust DSP</span>
          <p className="small muted" style={{ margin: 0 }}>16 kHz resample, silence suppression, batched emission. Toggles apply immediately — live.</p>
          <Toggle checked={nativeMic} onChange={(v) => void toggleNativeMic(v)} label="Native microphone" />
          <div className="row">
            <select value={micDeviceId} onChange={(e) => setMicDeviceId(e.target.value)} style={{ flex: 1 }}>
              <option value="default">Default microphone</option>
              {micDevices.filter((d) => d.id !== "default").map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <button className="ghost" onClick={async () => { try { setMicDevices(await listInputDevices()); } catch (e) { notify("error", `Device list failed: ${errText(e)}`); } }}>Refresh</button>
          </div>
          <Toggle checked={nativeSystem} onChange={(v) => void toggleNativeSystem(v)} label="Native system audio (loopback)" />
          <span className="small muted">Loopback captures everything the OS plays (Zoom/Meet/Teams/browser). Mic captures your voice and room audio.</span>
        </div>

        <div className="card grid">
          <span className="kicker">Screen capture - vision</span>
          <p className="small muted" style={{ margin: 0 }}>One-shortcut capture for code/problem screenshots. Sends to vision fallback when available.</p>
          <div className="row">
            <button
              onClick={async () => {
                try {
                  const b64 = await invoke<string>("take_screenshot");
                  setShot(`data:image/png;base64,${b64}`);
                } catch (e) {
                  notify("error", `Screenshot failed: ${errText(e)}`);
                }
              }}
            >
              Take screenshot
            </button>
            <button className="ghost" onClick={async () => { try { await invoke("open_cropper"); } catch (e) { notify("error", `Cropper failed: ${errText(e)}`); } }}>
              Cropper
            </button>
          </div>
          {shot && (
            <>
              <img src={shot} alt="capture" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
              <button className="primary" disabled={busy || !sessionId} onClick={() => void solveWithVision()}>
                Solve with vision
              </button>
            </>
          )}
          {visionAnswer && (
            <div className="card small" style={{ background: "var(--surface-2)", whiteSpace: "pre-wrap" }}>
              {visionAnswer}
            </div>
          )}
          {visionAnswer?.includes("```") && (
            <button className="ghost" disabled={codeRun === "busy"} onClick={() => void runVisionCode()}>
              {codeRun === "busy" ? "Running…" : "Run code"}
            </button>
          )}
          {codeRun && codeRun !== "busy" && (
            <pre className="small mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 10, borderRadius: 8, maxHeight: 220, overflow: "auto" }}>{codeRun}</pre>
          )}
          <span className="small muted">Routed through the platform vision fallback chain.</span>
        </div>

        <div className="card grid">
          <span className="kicker">Stealth controls</span>
          <Toggle checked={!!stealth.captureExclusion} disabled={stealthBusy === "capture"} onChange={(v) => void toggleCapture(v)} label={stealthBusy === "capture" ? "Applying…" : "Hide from screen capture"} />
          <Toggle checked={!!stealth.taskbarHidden} disabled={stealthBusy === "taskbar"} onChange={(v) => void toggleTaskbar(v)} label={stealthBusy === "taskbar" ? "Applying…" : "Hide from taskbar"} />
          <div className="row">
            <select
              value={stealth.masquerade ?? "none"}
              disabled={stealthBusy === "masquerade"}
              onChange={(e) => void setMasqueradeProfile(e.target.value as MasqueradeProfile)}
            >
              <option value="none">No masquerade</option>
              <option value="notepad">Notepad</option>
              <option value="terminal">Terminal</option>
              <option value="explorer">File Explorer</option>
              <option value="settings">Settings</option>
              <option value="chrome">Chrome</option>
              <option value="zoom">Zoom</option>
              <option value="teams">Teams</option>
              <option value="meet">Meet</option>
            </select>
          </div>
          <button className="primary" disabled={stealthBusy === "universal"} onClick={() => void enableStealthForAllBrowsersAndApps()}>
            {stealthBusy === "universal" ? "Enforcing…" : "Enable stealth for all browsers & apps (Chrome/Zoom/Meet/Teams)"}
          </button>
          <span className="small muted">One-click: WDA 0x11 + TOOLWINDOW for every window — works on any share client.</span>
          <Toggle checked={overlayOn} onChange={(v) => void toggleOverlay(v)} label="Stealth overlay — live answers (Ctrl+Shift+O)" />
          <div className="small muted">Position: Ctrl+Shift+P cycles top-center → right → left · Passthrough: Ctrl+Shift+B</div>
          <div className="small muted">Applied: capture={String(stealth.captureExclusion)} taskbar={String(stealth.taskbarHidden)} masquerade={stealth.masquerade}</div>
          <div className="small muted">Recovery: Ctrl+Shift+H shows/hides the app · the tray menu always reaches a hidden window.</div>
        </div>
      </div>
    </div>
  );
}
