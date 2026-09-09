import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackSttEngine, type SttEngine } from "./stt.js";

function fakeEngine(warmed: { count: number }, opts: { throws?: boolean } = {}): SttEngine {
  return {
    source: "local_stt",
    feed: () => {},
    flush: () => {},
    warmup: () => {
      warmed.count += 1;
      if (opts.throws) throw new Error("warmup blew up");
    },
  };
}

test("fallback chain warmup reaches primary and fallback, never throws", () => {
  const primary = { count: 0 };
  const fallback = { count: 0 };
  const chain = new FallbackSttEngine(fakeEngine(primary), fakeEngine(fallback));
  chain.warmup?.();
  assert.equal(primary.count, 1, "primary rung warms");
  assert.equal(fallback.count, 1, "fallback rung warms too — no cold failover mid-session");
});

test("a throwing warmup is swallowed — connect must never fail on it", () => {
  const fallback = { count: 0 };
  const chain = new FallbackSttEngine(fakeEngine({ count: 0 }, { throws: true }), fakeEngine(fallback));
  chain.warmup?.(); // must not throw
  assert.equal(fallback.count, 1, "chain continues to the fallback rung");
});

test("engines without warmup stay compatible (optional method)", () => {
  const plain: SttEngine = { source: "simulated", feed: () => {}, flush: () => {} };
  const chain = new FallbackSttEngine(plain, plain);
  chain.warmup?.(); // no-op, must not throw
});
