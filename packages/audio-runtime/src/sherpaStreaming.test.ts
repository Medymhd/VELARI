import { test } from "node:test";
import assert from "node:assert/strict";
import { SherpaStreamingSttEngine, type SherpaModule, type SherpaOnlineStream } from "./sherpaStreaming.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted recognizer: every accepted waveform refills a 2-frame decode
 * budget (like a real streaming decoder); `getText` drives the hypothesis;
 * `endpoint` drives the endpoint detector.
 */
function fakeModule(
  script: { getText: () => string; endpoint: boolean },
  calls: { resets: number },
) {
  class FakeStream implements SherpaOnlineStream {
    accepted: Float32Array[] = [];
    acceptWaveform(wave: { samples: Float32Array }): void {
      this.accepted.push(wave.samples);
      readyCount += 2;
    }
  }

  let readyCount = 0;
  const streams: FakeStream[] = [];
  const module: SherpaModule = {
    OnlineRecognizer: class {
      createStream(): SherpaOnlineStream {
        const s = new FakeStream();
        streams.push(s);
        return s;
      }
      isReady(): boolean {
        return readyCount-- > 0;
      }
      decode(): void {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getResult(_s: SherpaOnlineStream): any {
        return { text: script.getText() };
      }
      isEndpoint(): boolean {
        return script.endpoint;
      }
      reset(): void {
        calls.resets += 1;
        readyCount = 0;
      }
    },
  };
  return { module, streams };
}

test("emits changing partials and a final on flush, then resets the stream", async () => {
  const calls = { resets: 0 };
  let n = 0;
  const { module, streams } = fakeModule({ getText: () => `words ${++n}`, endpoint: false }, calls);
  const engine = new SherpaStreamingSttEngine({ loadModule: () => module, modelDir: "unused" });

  const results: string[] = [];
  const handler = (r: { isFinal: boolean; text: string }) => results.push(`${r.isFinal ? "final" : "partial"}:${r.text}`);

  engine.feed(Buffer.alloc(3200 * 2), 0, handler); // 200ms → two decode windows
  engine.feed(Buffer.alloc(3200 * 2), 200, handler);
  await sleep(1);

  assert.ok(results.filter((r) => r.startsWith("partial:")).length >= 2, "a partial per distinct decode");
  assert.equal(streams.length, 1, "one stream across feeds");

  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  assert.equal(finals.length, 1, "flush emits the utterance final");
  assert.equal(calls.resets, 1, "stream reset after final");
  engine.close();
});

test("endpoint detection emits a final and resets mid-stream", () => {
  const calls = { resets: 0 };
  const { module } = fakeModule({ getText: () => "hello", endpoint: true }, calls);
  const engine = new SherpaStreamingSttEngine({ loadModule: () => module, modelDir: "unused" });

  const out: string[] = [];
  engine.feed(Buffer.alloc(3200 * 2), 0, (r) => out.push(`${r.isFinal ? "final" : "partial"}:${r.text}`));
  assert.ok(out.includes("final:hello"), "endpoint commits the utterance");
  assert.ok(calls.resets >= 1, "stream reset on endpoint");
  engine.close();
});

test("init failure fires onUnavailable instead of throwing", async () => {
  const engine = new SherpaStreamingSttEngine({
    loadModule: () => {
      throw new Error("native binding missing");
    },
    modelDir: "unused",
  });
  let unavailable = 0;
  engine.onUnavailable(() => {
    unavailable += 1;
  });
  const results: unknown[] = [];
  engine.feed(Buffer.alloc(3200 * 2), 0, (r) => results.push(r));
  engine.flush((r) => results.push(r));
  await sleep(1);
  assert.equal(unavailable, 1, "missing model → unavailable, chain degrades");
  assert.equal(results.length, 0, "no results emitted when unavailable");
  engine.close();
});
