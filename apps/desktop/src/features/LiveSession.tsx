import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { stealthGetState, stealthSetCapture, stealthSetMasquerade, stealthSetTaskbar } from "../lib/tauri";
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
import { StatusPill, Section } from "@app/ui";

const nativeAvailable = isTauri();

function base64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function useRealtime(sessionId: string | null) {
  const { pushTranscript, pushInsight, setConnected, setError } = useStore();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    const url = api.wsUrl(sessionId);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Fallback demo tick when API is unreachable
      const t = setInterval(() => {
        pushTranscript({ id: Math.random().toString(36).slice(2), sequenceNo: Date.now(), text: "Demo mode: connect the platform API to get live transcription.", isFinal: true });
      }, 3500);
      return () => clearInterval(t);
    }
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => { if (!closed) setConnected(false); };
    ws.onerror = () => setError("realtime connection failed");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; segment?: { id: string; sequenceNo: number; text: string; isFinal: boolean; confidence?: number; speaker?: string }; insight?: { id: string; contentJson: Record<string, unknown>; createdAt: string } };
        if (msg.type === "transcript.final" || msg.type === "transcript.partial") {
          const s = msg.segment!;
          pushTranscript({ id: s.id, sequenceNo: s.sequenceNo, text: s.text, isFinal: s.isFinal, confidence: s.confidence, speaker: s.speaker === "user" || s.speaker === "interviewer" ? s.speaker : undefined });
        } else if (msg.type === "coach.suggestion" && msg.insight) {
          pushInsight({ id: msg.insight.id, contentJson: msg.insight.contentJson, createdAt: msg.insight.createdAt });
        }
      } catch { /* ignore */ }
    };
    return () => { closed = true; ws.close(); };
  }, [sessionId, pushInsight, pushTranscript, setConnected, setError]);

  return wsRef;
}

export default function LiveSession() {
  const { sessionId, sessionStatus, transcript, insights, connected, workspaceId, pushTranscript, setSession, stealth, setStealth, consentConfirmed, setConsent } = useStore();
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [visionAnswer, setVisionAnswer] = useState<string | null>(null);
  const wsRef = useRealtime(sessionId);

  // Audio capture -> WS audio.chunk (AudioWorklet primary, ScriptProcessor fallback)
  const audioRef = useRef<{ ctx: AudioContext; node: AudioWorkletNode | null; proc: ScriptProcessorNode | null; stream: MediaStream } | null>(null);

  // Native (Rust) capture â€” DSP runs in the Tauri backend; batches arrive as events.
  const [nativeMic, setNativeMic] = useState(false);
  const [nativeSystem, setNativeSystem] = useState(false);
  const [micDevices, setMicDevices] = useState<NativeAudioDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("default");
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const nativeActiveRef = useRef(false);

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

  // Global chord (Ctrl+Shift+O) toggles the stealth overlay; registered once.
  const overlayOnRef = useRef(false);
  useEffect(() => {
    if (!nativeAvailable) return;
    invoke("register_global_chord", { chord: "Ctrl+Shift+O", action: "overlay-toggle" }).catch((e) =>
      console.warn("global chord unavailable", e),
    );
    let un: UnlistenFn | null = null;
    void listen("chord://activated", () => {
      const next = !overlayOnRef.current;
      overlayOnRef.current = next;
      setOverlayOn(next);
      void invoke(next ? "overlay_show" : "overlay_hide").catch(() => {
        overlayOnRef.current = false;
        setOverlayOn(false);
      });
    }).then((u) => (un = u));
    return () => un?.();
  }, [nativeAvailable]);

  async function toggleOverlay() {
    const next = !overlayOnRef.current;
    overlayOnRef.current = next;
    setOverlayOn(next);
    try {
      await invoke(next ? "overlay_show" : "overlay_hide");
    } catch (e) {
      console.warn("overlay failed", e);
      overlayOnRef.current = false;
      setOverlayOn(false);
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
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
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

  async function startNativeCapture() {
    if (!nativeAvailable) return;
    try {
      const unlisten: UnlistenFn[] = [];
      if (nativeMic) {
        const info = await startMicCapture(micDeviceId === "default" ? undefined : micDeviceId);
        console.info("native mic capture started", info);
        unlisten.push(await listenMicBatches(forwardNativeBatch));
      }
      if (nativeSystem) {
        const info = await startSystemCapture();
        console.info("native system capture started", info);
        unlisten.push(await listenSystemBatches(forwardNativeBatch));
      }
      unlistenRef.current = unlisten;
      nativeActiveRef.current = unlisten.length > 0;
    } catch (ex) {
      console.warn("native capture failed", ex);
      await stopNativeCapture();
    }
  }

  async function stopNativeCapture() {
    for (const un of unlistenRef.current.splice(0)) un();
    if (!nativeAvailable || !nativeActiveRef.current) return;
    nativeActiveRef.current = false;
    await stopMicCapture().catch(() => {});
    await stopSystemCapture().catch(() => {});
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
      console.warn("mic capture failed", ex);
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

  useEffect(() => () => { stopCapture(); void stopNativeCapture(); stopRelayDirect(); }, []);

  async function act(action: "start" | "pause" | "complete") {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.sessionAction(sessionId, action);
      const next = action === "start" ? "live" : action === "pause" ? "paused" : "completed";
      setSession(sessionId, next);
      if (action === "start") {
        void startCapture();
        if (nativeAvailable && (nativeMic || nativeSystem)) void startNativeCapture();
      }
      if (action === "complete" || action === "pause") {
        stopCapture();
        void stopNativeCapture();
        stopRelayDirect();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleCapture() {
    const next = !stealth.captureExclusion;
    const s = await stealthSetCapture(next);
    setStealth(s);
  }

  async function toggleTaskbar() {
    const next = !stealth.taskbarHidden;
    const s = await stealthSetTaskbar(next);
    setStealth(s);
  }

  async function enableStealthForAllBrowsersAndApps() {
    try {
      // The Rust side reads the real foreground window title — no UA guessing.
      const s = await invoke<any>("stealth_enable_for_all_browsers_and_apps");
      setStealth(s);
    } catch (e) {
      console.warn("universal stealth failed", e);
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
      console.warn("vision failed", e);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId) return <div className="card muted">Select or create a session from Home.</div>;

  return (
    <div className="grid" style={{ gridTemplateColumns: "1.2fr 0.8fr", alignItems: "start" }}>
      <div className="grid">
        <div className="card row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <span className="dot" style={{ background: connected ? "var(--success)" : "var(--muted)" }} />
            <StatusPill status={sessionStatus} />
            <span className="badge">{connected ? "realtime connected" : "offline"}</span>
            {relayActive && <span className="badge warn">direct relay</span>}
            {overlayOn && <span className="badge accent">overlay live</span>}
            {!consentConfirmed && <span className="badge warn">consent required</span>}
          </div>
          <div className="row">
            <button disabled={busy || !consentConfirmed} onClick={() => void act("start")}>Start</button>
            <button disabled={busy} onClick={() => void act("pause")}>Pause</button>
            <button disabled={busy} className="primary" onClick={() => void act("complete")}>Complete</button>
          </div>
        </div>

        <label className="row small">
          <input type="checkbox" checked={consentConfirmed} onChange={(e) => setConsent(e.target.checked)} style={{ width: 16, height: 16 }} />
          I have consent to record and process this session.
        </label>

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
                <div key={t.id} className={`seg-enter ${confClass}`} style={{ opacity: t.isFinal ? 1 : 0.55, borderLeft: `2px solid ${t.isFinal ? "var(--accent)" : "var(--border)"}`, paddingLeft: 10 }}>
                  <div style={{ fontSize: 13 }}>
                    {t.speaker && <span className="small muted" style={{ marginRight: 6 }}>[{t.speaker === "user" ? "You" : "Interviewer"}]</span>}
                    {t.text}
                  </div>
                  <div className="small muted">#{t.sequenceNo} {t.isFinal ? "final" : "partial"} {t.confidence ? `· ${(t.confidence * 100).toFixed(0)}%` : ""}</div>
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
          <p className="small muted" style={{ margin: 0 }}>16 kHz resample, silence suppression, batched emission. Applies on session start.</p>
          <label className="row small" style={{ justifyContent: "space-between" }}>
            <span>Native microphone</span>
            <input type="checkbox" checked={nativeMic} onChange={(e) => setNativeMic(e.target.checked)} style={{ width: 18, height: 18 }} />
          </label>
          <div className="row">
            <select value={micDeviceId} onChange={(e) => setMicDeviceId(e.target.value)} style={{ flex: 1 }}>
              <option value="default">Default microphone</option>
              {micDevices.filter((d) => d.id !== "default").map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <button className="ghost" onClick={() => void listInputDevices().then(setMicDevices).catch(() => {})}>Refresh</button>
          </div>
          <label className="row small" style={{ justifyContent: "space-between" }}>
            <span>Native system audio (loopback)</span>
            <input type="checkbox" checked={nativeSystem} onChange={(e) => setNativeSystem(e.target.checked)} style={{ width: 18, height: 18 }} />
          </label>
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
                  console.warn("screenshot failed", e);
                }
              }}
            >
              Take screenshot
            </button>
            <button className="ghost" onClick={async () => { try { await invoke("open_cropper"); } catch {} }}>
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
          <span className="kicker">Stealth controls - red-team mode</span>
          <p className="small muted" style={{ margin: 0 }}>For the make-then-break exercise. The red team is expected to detect these.</p>
          <label className="row small" style={{ justifyContent: "space-between" }}>
            <span>Hide from screen capture</span>
            <input type="checkbox" checked={stealth.captureExclusion} onChange={() => void toggleCapture()} style={{ width: 18, height: 18 }} />
          </label>
          <label className="row small" style={{ justifyContent: "space-between" }}>
            <span>Hide from taskbar</span>
            <input type="checkbox" checked={stealth.taskbarHidden} onChange={() => void toggleTaskbar()} style={{ width: 18, height: 18 }} />
          </label>
          <div className="row">
            <select
              value={stealth.masquerade}
              onChange={async (e) => {
                const s = await stealthSetMasquerade(e.target.value as never);
                setStealth(s);
                await stealthGetState().then(setStealth).catch(() => {});
              }}
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
          <button className="primary" onClick={() => void enableStealthForAllBrowsersAndApps()}>
            Enable stealth for all browsers & apps (Chrome/Zoom/Meet/Teams)
          </button>
          <span className="small muted">One-click: WDA 0x11 + TOOLWINDOW for every window — works on any share client.</span>
          <label className="row small" style={{ justifyContent: "space-between" }}>
            <span>Stealth overlay — live answers</span>
            <input type="checkbox" checked={overlayOn} onChange={() => void toggleOverlay()} style={{ width: 18, height: 18 }} />
          </label>
          <div className="small muted">Applied: capture={String(stealth.captureExclusion)} taskbar={String(stealth.taskbarHidden)} masquerade={stealth.masquerade}</div>
        </div>
      </div>
    </div>
  );
}
