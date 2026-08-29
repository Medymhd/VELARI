import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mintSessionToken, verifySessionToken } from "./sttRelay.js";

const SECRET = "test-relay-secret";

test("mint/verify round trip preserves claims", () => {
  const token = mintSessionToken("user-1:ws-1", { secret: SECRET, ttlMs: 90_000, nowMs: 1_000 });
  const claims = verifySessionToken(token, { secret: SECRET, nowMs: 2_000 });
  assert.ok(claims);
  assert.equal(claims.sub, "user-1:ws-1");
  assert.equal(claims.ws, "stt-relay");
  assert.equal(claims.exp, 91_000);
});

test("expired token is rejected", () => {
  const token = mintSessionToken("user-1:ws-1", { secret: SECRET, ttlMs: 1_000, nowMs: 0 });
  assert.equal(verifySessionToken(token, { secret: SECRET, nowMs: 1_001 }), null);
});

test("tampered signature is rejected", () => {
  const token = mintSessionToken("user-1:ws-1", { secret: SECRET });
  const [payload] = token.split(".");
  const forgedSig = createHmac("sha256", "wrong-secret").update(payload!).digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${forgedSig}`, { secret: SECRET }), null);
});

test("tampered payload is rejected", () => {
  const token = mintSessionToken("user-1:ws-1", { secret: SECRET });
  const other = mintSessionToken("attacker:ws-9", { secret: SECRET });
  const [otherPayload] = other.split(".");
  const [, goodSig] = token.split(".");
  assert.equal(verifySessionToken(`${otherPayload}.${goodSig}`, { secret: SECRET }), null);
});

test("malformed tokens are rejected", () => {
  assert.equal(verifySessionToken("", { secret: SECRET }), null);
  assert.equal(verifySessionToken("no-dot", { secret: SECRET }), null);
  assert.equal(verifySessionToken("a.b.c", { secret: SECRET }), null);
  // Valid HMAC over a non-JSON payload
  const payload = Buffer.from("not json").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${sig}`, { secret: SECRET }), null);
});
