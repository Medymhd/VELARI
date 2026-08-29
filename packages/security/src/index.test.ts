import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretBox, privacyAllows, redactSecretLike } from "./index.js";

test("seal/open roundtrip", () => {
  const box = new SecretBox("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const sealed = box.seal("sk-test-1234567890");
  assert.match(sealed.sealed, /^v1\./);
  assert.equal(box.open(sealed.sealed), "sk-test-1234567890");
});

test("different master key cannot open", () => {
  const a = new SecretBox("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const b = new SecretBox("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const sealed = a.seal("secret");
  assert.throws(() => b.open(sealed.sealed));
});

test("privacy gates", () => {
  assert.equal(privacyAllows("local_only", "managed"), false);
  assert.equal(privacyAllows("local_only", "local"), true);
  assert.equal(privacyAllows("byok_only", "managed"), false);
  assert.equal(privacyAllows("byok_only", "byok"), true);
  assert.equal(privacyAllows("managed_allowed", "managed"), true);
});

test("redaction strips key-like strings", () => {
  const out = redactSecretLike("auth bearer sk-proj-abcdefghij1234567890 ok");
  assert.ok(!out.includes("sk-proj-abcdefghij1234567890"));
});
