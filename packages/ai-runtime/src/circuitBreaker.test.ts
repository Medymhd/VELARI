import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreakerRegistry } from "./circuitBreaker.js";

const K = ["ws1", "openai", "gpt-4o", "live_coach"] as const;

test("breaker opens after threshold failures within window", () => {
  const b = new CircuitBreakerRegistry();
  for (let i = 0; i < 4; i++) {
    assert.equal(b.check(...K).allowed, true);
    b.recordFailure(...K);
  }
  // 5th failure crosses threshold → subsequent attempts blocked
  b.recordFailure(...K);
  assert.equal(b.check(...K).allowed, false);
});

test("open breaker half-opens after cooldown and closes after probes", () => {
  const b = new CircuitBreakerRegistry();
  for (let i = 0; i < 5; i++) {
    b.check(...K);
    b.recordFailure(...K);
  }
  assert.equal(b.check(...K).state, "open");

  // simulate cooldown expiry by backdating
  const reg = b as unknown as { entries: Map<string, { openedAt: number }> };
  const e = reg.entries.get(K.join(":"));
  if (e) e.openedAt = Date.now() - 31_000;

  const half = b.check(...K);
  assert.equal(half.state, "half_open");
  assert.equal(half.allowed, true);

  for (let i = 0; i < 3; i++) b.recordSuccess(...K);
  const closed = b.check(...K);
  assert.equal(closed.state, "closed");
  assert.equal(closed.allowed, true);
});
