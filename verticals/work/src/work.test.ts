import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedDomain, requiresApproval } from "./types.js";

test("allowedDomains default blank [] blocks until policy set (valeriworkvertical.md §5)", () => {
  assert.equal(isAllowedDomain("https://outlierclone.io/task/1", []), false);
  assert.equal(isAllowedDomain("https://client.example.com/work", []), false);
  assert.equal(isAllowedDomain("https://outlierclone.io/task/1", ["outlierclone.io"]), true);
  assert.equal(isAllowedDomain("https://sub.client.example.com/page", ["client.example.com"]), true);
});

test("credential kinds via vault secret_ref (Google API / email+password / API key)", () => {
  const kind = (ref?: string) => (ref?.startsWith("oauth:") ? "google_api" : ref?.startsWith("apikey:") ? "api_key" : ref ? "email_password" : "none");
  assert.equal(kind("oauth:google-123"), "google_api");
  assert.equal(kind("apikey:sk-live-xyz"), "api_key");
  assert.equal(kind("vault://email-pass-ref"), "email_password");
});

test("approval vs auto-approve (major test with other team)", () => {
  assert.equal(requiresApproval("external_write", false), true);
  assert.equal(requiresApproval("external_write", true), false);
  assert.equal(requiresApproval("read", false), false);
  assert.equal(requiresApproval("read", true), false);
});
