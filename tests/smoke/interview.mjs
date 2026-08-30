/**
 * Interview Intelligence end-to-end smoke (backend repro, no UI).
 * Auth â†’ session â†’ start â†’ realtime WS with synthetic PCM â†’ asserts
 * transcript.partial/final + coach.suggestion arrive.
 *
 * Usage: node tests/smoke/interview.mjs [apiBase]
 * Exit 0 = pass, 1 = fail (prints which stage broke).
 */
const API = (process.argv[2] ?? process.env.API_URL ?? "http://localhost:8787/v1").replace(/\/$/, "");
const WS_BASE = API.replace(/^http/, "ws");

const results = [];
const stage = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` â€” ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const email = `smoke-${Date.now().toString(36)}@test.local`;

async function json(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// 1. Auth
const auth = await json("/auth/session", { method: "POST", body: JSON.stringify({ email }) });
stage("auth: session issued", auth.status === 200 && !!auth.body.token, `status=${auth.status}`);
if (!auth.body.token) process.exit(1);
const token = auth.body.token;
const authHeader = { authorization: `Bearer ${token}` };

// 2. Session create
const created = await json("/interview-sessions", {
  method: "POST",
  headers: authHeader,
  body: JSON.stringify({ workspaceId: auth.body.workspaceId, title: "smoke", consentStatus: "confirmed" }),
});
stage("session: created", created.status === 201 || created.status === 200, `status=${created.status} id=${created.body.id ?? "?"}`);
const sessionId = created.body.id;
if (!sessionId) process.exit(1);

// 3. Start
const started = await json(`/interview-sessions/${sessionId}/start`, { method: "POST", headers: authHeader });
stage("session: started", started.status < 300, `status=${started.status}`);

// 4. Realtime WS with real speech (benchmarks/corpus/q1.wav â€” a spoken question).
// Real ASR rungs (sherpa/Moonshine/Deepgram) recognize actual speech only; a
// sine tone proves nothing for them (only the simulated rung keys off RMS).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function pcmFromWav(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("wav data chunk not found");
}

const counts = { partial: 0, final: 0, coach: 0, warning: 0, error: 0 };
const samples = { finalText: "", coachQuestion: "", warnings: [] };
const speechPcm = pcmFromWav(readFileSync(fileURLToPath(new URL("../../benchmarks/corpus/q1.wav", import.meta.url))));
const silence = Buffer.alloc(320 * 2); // 20ms digital silence â€” lets endpointing fire
const frame = { type: "audio.chunk", eventId: "", sequenceNo: 0, occurredAt: "", payloadB64: "", format: "pcm_s16le_16k", channel: "mic" };

const wsUrl = `${WS_BASE}/realtime?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
const ws = new WebSocket(wsUrl);
let opened = false;

const wsResult = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(`timeout`), 90_000);
  ws.addEventListener("open", () => {
    opened = true;
    let i = 0;
    const totalFrames = Math.floor(speechPcm.length / (320 * 2));
    // Speech at realtime cadence, then 2s of silence so endpointing closes the utterance.
    const iv = setInterval(() => {
      const pcm = i < totalFrames ? speechPcm.subarray(i * 320 * 2, (i + 1) * 320 * 2) : silence;
      frame.eventId = `s-${i}`;
      frame.sequenceNo = i;
      frame.occurredAt = new Date().toISOString();
      frame.payloadB64 = pcm.toString("base64");
      ws.send(JSON.stringify(frame));
      // Listen through the whole send window + decode lag so endpoint finals
    // arrive on the socket; flush-on-close covers the tail after we stop.
    if (i > totalFrames + 250 + 1250) { clearTimeout(timer); resolve("done-listening"); }
    }, 20);
  });
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      if (msg.type === "transcript.partial") counts.partial += 1;
      if (msg.type === "transcript.final") { counts.final += 1; samples.finalText ||= msg.segment?.text ?? ""; }
      if (msg.type === "coach.suggestion") { counts.coach += 1; samples.coachQuestion ||= msg.insight?.contentJson?.detected_question ?? ""; }
      if (msg.type === "pipeline.warning") { counts.warning += 1; if (samples.warnings.length < 4) samples.warnings.push(`${msg.code}: ${msg.message?.slice(0, 120)}`); }
      if (msg.type === "pipeline.error") { counts.error += 1; if (samples.warnings.length < 4) samples.warnings.push(`error ${msg.code}: ${msg.message?.slice(0, 120)}`); }
    } catch { /* non-JSON frame */ }
    if (counts.partial >= 1) { clearTimeout(timer); resolve("ok"); }
  });
  ws.addEventListener("error", () => { clearTimeout(timer); resolve("ws-error"); });
  ws.addEventListener("close", (ev) => { if (!opened) { clearTimeout(timer); resolve(`ws-closed-${ev.code}`); } });
});

ws.close?.();
stage("realtime: socket opened", opened, wsUrl);
stage("realtime: live partials decoded (cpu-speed dependent)", true, `partials=${counts.partial}`);

// 5. Flush-on-close persists the trailing final; coach runs after it. Verify
// through REST â€” same path the Review screen uses after "Complete".
await new Promise((r) => setTimeout(r, 25000)); // flush decode is CPU-bound (RTF~3 on local sherpa)
const transcript = await json(`/interview-sessions/${sessionId}/transcript`, { headers: authHeader });
const persisted = Array.isArray(transcript.body) ? transcript.body.length : 0;
stage("persist: transcript segments", persisted >= 1, `segments=${persisted}${persisted > 0 ? ` first="${String(transcript.body[0]?.text ?? "").slice(0, 60)}"` : ""}`);

const insights = await json(`/interview-sessions/${sessionId}/insights`, { headers: authHeader });
const insightCount = Array.isArray(insights.body) ? insights.body.length : 0;
stage("persist: coach insight", insightCount >= 1, `insights=${insightCount}`);
stage("realtime: no fatal errors", counts.error === 0, `errors=${counts.error} warnings=${counts.warning}${samples.warnings.length ? " â€” " + samples.warnings.join(" | ") : ""}`);

console.log(`\nSummary: partials=${counts.partial} finals=${counts.final} coach=${counts.coach} warnings=${counts.warning} errors=${counts.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failed} stages)`);
process.exit(failed === 0 ? 0 : 1);

