import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonshineStreamingSttEngine, type MoonshinePipeline } from "./moonshineStreaming.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted pipeline: returns `getText(bufferSeconds)` per decode call. */
function fakeFactory(log: { decodeCalls: number }) {
  let n = 0;
  const factory: () => Promise<MoonshinePipeline> = async () => {
    const pipeline: MoonshinePipeline = async (audio) => {
      log.decodeCalls += 1;
      void audio;
      return { text: `transcript ${++n}` };
    };
    return pipeline;
  };
  return factory;
}

test("emits a partial on the re-decode cadence and a final on flush", async () => {
  const log = { decodeCalls: 0 };
  const engine = new MoonshineStreamingSttEngine({
    factory: fakeFactory(log),
    partialEveryMs: 100, // decode after 100ms of new audio
    sampleRate: 16000,
  });
  const results: string[] = [];
  const handler = (r: { isFinal: boolean; text: string }) => results.push(`${r.isFinal ? "final" : "partial"}:${r.text}`);

  // 5 feeds of 100ms each → 500ms buffer crosses both the 400ms minimum and
  // the 100ms re-decode cadence.
  for (let i = 0; i < 5; i++) {
    engine.feed(Buffer.alloc(1600 * 2), i * 100, handler);
    await sleep(5);
  }
  await sleep(20);
  const partials = results.filter((r) => r.startsWith("partial:"));
  assert.ok(partials.length >= 1, "at least one partial after cadence threshold");

  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  await sleep(30);
  assert.equal(finals.length, 1, "flush emits the utterance final");
  assert.ok(log.decodeCalls >= 1);
  engine.close();
});

test("backspace-free buffer resets after final — next utterance starts clean", async () => {
  const log = { decodeCalls: 0 };
  const engine = new MoonshineStreamingSttEngine({ factory: fakeFactory(log), partialEveryMs: 50 });
  engine.feed(Buffer.alloc(3200 * 2), 0, () => {});
  await sleep(20);
  const finals: { text: string }[] = [];
  engine.flush((r) => finals.push(r));
  await sleep(20);
  assert.equal(finals.length, 1);
  engine.feed(Buffer.alloc(1600 * 2), 1000, () => {});
  await sleep(20);
  engine.flush((r) => finals.push(r));
  await sleep(20);
  assert.equal(finals.length, 2, "second utterance decodes independently");
  engine.close();
});

test("init failure fires onUnavailable and the engine goes inert", async () => {
  const engine = new MoonshineStreamingSttEngine({
    factory: () => Promise.reject(new Error("model download failed")),
  });
  let unavailable = 0;
  engine.onUnavailable(() => {
    unavailable += 1;
  });
  const results: unknown[] = [];
  engine.feed(Buffer.alloc(3200 * 2), 0, (r) => results.push(r));
  engine.flush((r) => results.push(r));
  await sleep(30);
  assert.equal(unavailable, 1, "unavailable fired once for chain degradation");
  assert.equal(results.length, 0, "no results when the model is unavailable");
  engine.close();
});
