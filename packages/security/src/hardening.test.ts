import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretBox, privacyAllows } from "./index.js";

test("tenant isolation: different workspaces cannot cross-decrypt", () => {
  const wsA = new SecretBox("master-key-workspace-A-00000000000000000000000000000000");
  const wsB = new SecretBox("master-key-workspace-B-11111111111111111111111111111111");
  const sealed = wsA.seal("sk-deepgram-123");
  assert.throws(() => wsB.open(sealed.sealed), /failed|malformed|error/i);
});

test("row-level isolation: privacy gate denies managed in local_only", () => {
  assert.equal(privacyAllows("local_only", "managed"), false);
  assert.equal(privacyAllows("local_only", "local"), true);
  assert.equal(privacyAllows("byok_only", "managed"), false);
  assert.equal(privacyAllows("managed_allowed", "managed"), true);
});

test("audit redaction: key-like strings are stripped before logging", async () => {
  const { redactSecretLike } = await import("./index.js");
  const raw = "Authorization: Bearer sk-proj-abcdef1234567890abcdef1234567890";
  const redacted = redactSecretLike(raw);
  assert.ok(!redacted.includes("sk-proj-abcdef1234567890"));
  assert.ok(redacted.includes("[REDACTED]"));
});
