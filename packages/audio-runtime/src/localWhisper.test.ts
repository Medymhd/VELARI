import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalWhisperSttEngine, wavFromPcm16 } from "./stt.js";

test("wav wrapper produces a valid RIFF header", () => {
  const pcm = Buffer.alloc(320 * 2, 7);
  const wav = wavFromPcm16(pcm);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test("flush posts WAV multipart to the local server and emits its transcript", async () => {
  const captured: { url: string; init: RequestInit }[] = [];
  const engine = new LocalWhisperSttEngine(
    "http://127.0.0.1:8000/v1",
    "whisper-large",
    (async (url: string | URL, init?: RequestInit) => {
      captured.push({ url: String(url), init: init as RequestInit });
      return { ok: true, status: 200, json: async () => ({ text: " hello from local " }) } as unknown as Response;
    }) as typeof fetch,
  );

  engine.feed(Buffer.alloc(320 * 2, 3), 1000, () => {});
  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(captured.length, 1);
  const call = captured[0]!;
  assert.equal(call.url, "http://127.0.0.1:8000/v1/audio/transcriptions");
  const body = String(call.init.body);
  assert.ok(body.includes('filename="audio.wav"'));
  assert.ok(body.includes("whisper-large"));
  assert.equal((finals[0] as { text: string }).text, "hello from local");
});

test("server failure degrades to a final instead of stalling", async () => {
  const engine = new LocalWhisperSttEngine(
    "http://127.0.0.1:9/v1",
    "m",
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  );
  engine.feed(Buffer.alloc(320 * 2), 0, () => {});
  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finals.length, 1);
  assert.ok((finals[0] as { text: string }).text.length > 0);
});

test("no server configured → simulated final", () => {
  const engine = new LocalWhisperSttEngine(undefined);
  engine.feed(Buffer.alloc(320 * 2), 0, () => {});
  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  assert.equal(finals.length, 1);
});
