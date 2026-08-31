import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
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

const nativeAvailable = isTauri();

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

function useRealtime(sessionId: string | null) {
  const { pushTranscript, pushInsight, setConnected, setError, notify } = useStore();
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
        const msg = JSON.parse(ev.data as string) as { type: string; code?: string; message?: string; segment?: { id: string; sequenceNo: number; text: string; isFinal: boolean; confidence?: number; speaker?: string; source?: string }; insight?: { id: string; contentJson: Record<string, unknown>; createdAt: string } };
        if (msg.type === "transcript.final" || msg.type === "transcript.partial") {
          const s = msg.segment!;
          pushTranscript({ id: s.id, sequenceNo: s.sequenceNo, text: s.text, isFinal: s.isFinal, confidence: s.confidence, speaker: s.speaker === "user" || s.speaker === "interviewer" ? s.speaker : undefined, source: s.source });
        } else if (msg.type === "coach.suggestion" && msg.insight) {
          pushInsight({ id: msg.insight.id, contentJson: msg.insight.contentJson, createdAt: msg.insight.createdAt });
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
  }, [sessionId, pushInsight, pushTranscript, setConnected, setError, notify]);

  return wsRef;
}

export default function LiveSession() {
  const { sessionId, sessionStatus, transcript, insights, connected, workspaceId, pushTranscript, setSession, stealth, setStealth, consentConfirmed, setConsent, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [stealthBusy, setStealthBusy] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [visionAnswer, setVisionAnswer] = useState<string | null>(null);
  const wsRef = useRealtime(sessionId);

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

  // Direct relay fallback (Â§5.1.5): native audio â†’ STT relay when the
  // realtime WS is down; finals replay to the session on reconnect.
  const relayRef = useRef<RelayDirectStream | null>(null);
  const [relayActive, setRelayActive] = useState(false);
  const pendingClientFinals = useRef<Record<string, unknown>[]>([]);
  const clientFinalSeq = useRef(0);
  const relayLastAttemptMs = useRef(0);

  // Stealth overlay: forward the live session into the always-on-top panel.
  const [overlayOn, setOverlayOn] = useState(false);
  const lastForwardedId = useRef<string | null>(null);

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
    else pendingClientFinals.current.push(frame);
  }

  // Replay finals captured while the realtime WS was down.
  useEffect(() => {
    if (!connected) return;
    for (const frame of pendingClientFinals.current.splice(0)) {
      wsRef.current?.send(JSON.stringify(frame));
    }
  }, [connected]);

  // Forward the live session into the stealth overlay panel.
  useEffect(() => {
    const t = transcript[transcript.length - 1];
    if (overlayOn && t && t.id !== lastForwardedId.current) {
      lastForwardedId.current = t.id;
      void emit("overlay://transcript", { speaker: t.speaker ?? null, text: t.text, isFinal: t.isFinal });
    }
  }, [transcript, overlayOn]);

  useEffect(() => {
    const ins = insights[insights.length - 1];
    if (overlayOn && ins) void emit("overlay://insight", { contentJson: ins.contentJson });
  }, [insights, overlayOn]);

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

  // Global chord (Ctrl+Shift+O) toggles the stealth overlay; also registered
  // app-wide in Rust at startup. Ctrl+Shift+H (app show/hide) is handled in
  // Rust directly so it works on every screen.
  const overlayOnRef = useRef(false);
  useEffect(() => {
    if (!nativeAvailable) return;
    invoke("register_global_chord", { chord: "Ctrl+Shift+O", action: "overlay-toggle" }).catch((e) =>
      console.warn("global chord unavailable", e),
    );
    let un: UnlistenFn | null = null;
    void listen("chord://activated", (e) => {
      const action = (e.payload as { action?: string }).action ?? "overlay-toggle";
      if (action !== "overlay-toggle") return;
      const next = !overlayOnRef.current;
      overlayOnRef.current = next;
      void toggleOverlay(next);
    }).then((u) => (un = u));
    return () => un?.();
  }, [nativeAvailable]);

  async function toggleOverlay(on: boolean) {
    overlayOnRef.current = on;
    setOverlayOn(on);
    try {
      if (on) await invoke("overlay_show", { params: { mode: "stealth", verticalId: "interview-intelligence" } });
      else await invoke("overlay_hide", { verticalId: "interview-intelligence" });
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
      const pcm = base64ToPcm(batch.dataB64);
      sendPcm(pcm, batch.channel);
      relayRef.current?.send(new Uint8Array(pcm.buffer));
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
        void startCapture();
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

  // STT engine visibility: the transcript frames carry the producing engine's
  // source — surface it so "demo" vs real transcription is never a mystery.
  const lastSource = transcript.slice().reverse().find((t) => t.source)?.source;

  if (!sessionId) return <div className="card muted">Select or create a session from Home.</div>;

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
            {lastSource && (
              <span className={`badge ${lastSource === "simulated" ? "danger" : ""}`} title={`Engine: ${lastSource}`}>
                STT: {lastSource === "simulated" ? "DEMO" : lastSource === "local_stt" ? "local" : lastSource === "cloud_stt" ? "cloud" : lastSource}
              </span>
            )}
            {!consentConfirmed && <span className="badge warn">consent required</span>}
          </div>
          <div className="row" style={{ flexWrap: "wrap", rowGap: 6 }}>
            <button disabled={busy || !consentConfirmed || !(sessionStatus === "draft" || sessionStatus === "paused")} onClick={() => void act("start")}>{busy && sessionStatus !== "live" ? "Starting…" : "Start"}</button>
            <button disabled={busy || sessionStatus !== "live"} onClick={() => void act("pause")}>Pause</button>
            <button disabled={busy || !(sessionStatus === "live" || sessionStatus === "paused")} className="primary" onClick={() => void act("complete")}>{busy && sessionStatus === "live" ? "Completing…" : "Complete"}</button>
            {sessionStatus === "completed" && <span className="small muted" style={{ alignSelf: "center" }}>Session completed — start a new one from Home.</span>}
          </div>
        </div>

        <Toggle checked={consentConfirmed} onChange={setConsent} label="I have consent to record and process this session." />

        {(() => {
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
                <span>Interviewer {100 - userPct}%</span>
              </div>
            </div>
          );
        })()}

        <div className="card stagger">
          <span className="kicker" style={{ marginBottom: 8, display: "block" }}>Transcript — finals are persisted, partials are ephemeral</span>
          <div className="scroll grid" style={{ gap: 8 }}>
            {transcript.length === 0 && <span className="small muted">No transcript yet. Start the session and speak.</span>}
            {transcript.slice(-80).map((t) => {
              const conf = t.confidence ?? 0;
              const confClass = conf >= 0.8 ? "conf-high" : conf >= 0.5 ? "conf-med" : conf > 0 ? "conf-low" : "";
              return (
                <div key={t.id} className={`seg-enter ${confClass} hud-scanlines`} style={{ opacity: t.isFinal ? 1 : 0.55, borderLeft: `2px solid ${t.isFinal ? "var(--accent)" : "var(--border)"}`, paddingLeft: 10, position: "relative" }}>
                  <div style={{ fontSize: 13 }} className={t.isFinal ? "" : "char-appear"}>
                    {t.speaker && <span className="small muted" style={{ marginRight: 6 }}>[{t.speaker === "user" ? "You" : "Interviewer"}]</span>}
                    {t.text}
                  </div>
                  <div className="small muted">#{t.sequenceNo} {t.isFinal ? "final" : "partial"} {t.confidence ? `· ${(t.confidence * 100).toFixed(0)}%` : ""}</div>
                  {t.confidence != null && <div className={`confidence-meter ${confClass.replace("conf-", "")}`}><div style={{ width: `${Math.round(conf * 100)}%` }} /></div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="card grid">
          <span className="kicker">Coaching</span>
          {insights.length === 0 && <span className="small muted">Suggestions appear here after transcript activity.</span>}
          {insights.slice(-6).reverse().map((ins) => (
            <div key={ins.id} className="card insight-arrive" style={{ background: "var(--surface-2)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{String(ins.contentJson.detected_question ?? "—")}</div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {(ins.contentJson.suggested_outline as string[] | undefined)?.map((o: string) => <li key={o}>{o}</li>)}
              </ul>
              <div className="small muted" style={{ marginTop: 6 }}>{(ins.contentJson.talking_points as string[] | undefined)?.join(" · ")}</div>
            </div>
          ))}
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
          <div className="small muted">Applied: capture={String(stealth.captureExclusion)} taskbar={String(stealth.taskbarHidden)} masquerade={stealth.masquerade}</div>
          <div className="small muted">Recovery: Ctrl+Shift+H shows/hides the app · the tray menu always reaches a hidden window.</div>
        </div>
      </div>
    </div>
  );
}
