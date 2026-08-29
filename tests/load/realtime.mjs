/**
 * Realtime load harness (§5.1.6): N concurrent simulated interview sessions
 * against a RUNNING platform API. Measures per-frame send cost, partial/final
 * arrival, and error rate under concurrency.
 *
 * Usage: node tests/load/realtime.mjs [--concurrency 20] [--seconds 30]
 * Requires: API on $API_URL (default http://localhost:8787/v1), Postgres up.
 * Not part of `pnpm test` — infrastructure-bound by design.
 */
import { createRequire } from "node:module";
void createRequire;

// Node ≥22 ships a global WebSocket client — no ws dependency needed here.

const args = process.argv.slice(2);
const get = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const CONCURRENCY = get("--concurrency", 20);
const SECONDS = get("--seconds", 20);
const API_URL = (process.env.API_URL ?? "http://localhost:8787/v1").replace(/\/$/, "");
const WS_BASE = API_URL.replace(/^http/, "ws");

const auth = async () => {
  const res = await fetch(`${API_URL}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `load-${Math.random().toString(36).slice(2)}@test.local` }),
  });
  if (!res.ok) throw new Error(`auth failed ${res.status}`);
  return res.json();
};

const feedChunks = (() => {
  // 320-sample (20ms @16k) loud frames — enough to drive simulated STT finals.
  const chunk = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i++) chunk.writeInt16LE(Math.round(Math.sin(i / 4) * 8000), i * 2);
  return Array.from({ length: 400 }, () => chunk);
})();

async function runSession(index, deadline) {
  const stats = { frames: 0, partials: 0, finals: 0, errors: 0 };
  try {
    const { token, workspaceId } = await auth();
    const session = await (
      await fetch(`${API_URL}/interview-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, consentStatus: "confirmed" }),
      })
    ).json();
    await fetch(`${API_URL}/interview-sessions/${session.id}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/realtime?sessionId=${session.id}&token=${encodeURIComponent(token)}`);
      let i = 0;
      const timer = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(timer);
          ws.close(1000);
          resolve();
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return; // wait for connect
        for (let k = 0; k < 3 && i < feedChunks.length; k++, i++) {
          ws.send(
            JSON.stringify({
              type: "audio.chunk",
              eventId: `${index}-${i}`,
              sequenceNo: i,
              occurredAt: new Date().toISOString(),
              payloadB64: feedChunks[i].toString("base64"),
              format: "pcm_s16le_16k",
              channel: i % 2 ? "system" : "mic",
            }),
          );
          stats.frames += 1;
        }
      }, 60); // ~3 chunks/tick = 60ms of audio per 60ms — realtime cadence
      // Native (undici) WebSocket: addEventListener, not .on.
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (msg.type === "transcript.partial") stats.partials += 1;
          if (msg.type === "transcript.final") stats.finals += 1;
        } catch {
          stats.errors += 1;
        }
      });
      ws.addEventListener("error", () => {
        stats.errors += 1;
        clearInterval(timer);
        resolve();
      });
      ws.addEventListener("close", () => {
        clearInterval(timer);
        resolve();
      });
    });

    await fetch(`${API_URL}/interview-sessions/${session.id}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    stats.errors += 1;
  }
  return stats;
}

const deadline = Date.now() + SECONDS * 1000;
const started = Date.now();
const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runSession(i, deadline)));

const totals = results.reduce((a, s) => ({ frames: a.frames + s.frames, partials: a.partials + s.partials, finals: a.finals + s.finals, errors: a.errors + s.errors }), { frames: 0, partials: 0, finals: 0, errors: 0 });
const wallMs = Date.now() - started;
console.log(
  JSON.stringify(
    {
      concurrency: CONCURRENCY,
      durationSeconds: SECONDS,
      wallMs,
      totals,
      framesPerSecond: Math.round((totals.frames / wallMs) * 1000),
      errorRate: totals.frames ? Number((totals.errors / Math.max(totals.frames, 1)).toFixed(4)) : 1,
    },
    null,
    2,
  ),
);
