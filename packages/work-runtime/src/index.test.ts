import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, WorkQueue, isAllowedDomain, requiresApproval } from "./index.js";

test("assertTransition allows valid and rejects invalid", () => {
  assert.doesNotThrow(() => assertTransition("draft", "assigned"));
  assert.doesNotThrow(() => assertTransition("submitted", "approved"));
  assert.throws(() => assertTransition("draft", "approved"), /cannot transition/);
});

test("WorkQueue priority ordering", () => {
  const q = new WorkQueue();
  q.enqueue({ id: "1", taskId: "a", priority: 1, enqueuedAt: new Date().toISOString() });
  q.enqueue({ id: "2", taskId: "b", priority: 10, enqueuedAt: new Date().toISOString() });
  assert.equal(q.dequeue()?.taskId, "b");
  assert.equal(q.size(), 1);
});

test("isAllowedDomain blank blocks until policy set", () => {
  assert.equal(isAllowedDomain("https://outlierclone.io/task/1", []), false);
  assert.equal(isAllowedDomain("https://outlierclone.io/task/1", ["outlierclone.io"]), true);
  assert.equal(isAllowedDomain("https://sub.client.example.com/page", ["client.example.com"]), true);
});

test("requiresApproval respects autoApprove", () => {
  assert.equal(requiresApproval("external_write", false), true);
  assert.equal(requiresApproval("external_write", true), false);
  assert.equal(requiresApproval("read", false), false);
});
