/**
 * Security hardening suite (§5.1.6): tenant isolation, auth boundaries,
 * secret redaction. Integration tests — they run against buildApp() + real
 * Postgres and SKIP cleanly when the database is unreachable, so the unit
 * suite never depends on infrastructure.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.js";
import { prisma } from "./db.js";
import { env } from "./env.js";

const app: FastifyInstance = await buildApp();

let dbUp = false;
const suffix = randomUUID().slice(0, 8);
const ownerEmail = `sec-owner-${suffix}@test.local`;
const outsiderEmail = `sec-out-${suffix}@test.local`;
let ownerId = "";
let outsiderId = "";
let workspaceId = "";
let sessionId = "";
const SECRET_MATERIAL = `sk-groq-test-${randomUUID()}`;

// Single setup hook: db probe + fixtures (node:test root-level hooks —
// only the first registered before() is guaranteed to gate the tests).
before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
  if (!dbUp) {
    console.warn("[fixtures] skipped, db unreachable");
    return;
  }
  try {
    const owner = await prisma.user.create({ data: { email: ownerEmail, displayName: "Owner" } });
    const outsider = await prisma.user.create({ data: { email: outsiderEmail, displayName: "Outsider" } });
    ownerId = owner.id;
    outsiderId = outsider.id;
    const ws = await prisma.workspace.create({ data: { name: `sec-ws-${suffix}` } });
    workspaceId = ws.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: ownerId, role: "owner" } });
    console.warn(`[fixtures] ok owner=${ownerId} ws=${workspaceId}`);
  } catch (e) {
    console.warn(`[fixtures] FAILED: ${String(e).slice(0, 400)}`);
    throw e;
  }
});

after(async () => {
  if (dbUp) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId } });
    await prisma.transcriptSegment.deleteMany({ where: { sessionId } });
    await prisma.sessionInsight.deleteMany({ where: { sessionId } });
    if (sessionId) await prisma.interviewSession.deleteMany({ where: { id: sessionId } });
    await prisma.providerConnection.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  }
  await app.close();
  await prisma.$disconnect();
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test("database reachable (else security suite skips)", (t) => {
  if (!dbUp) t.skip("postgres unreachable — start infra:up to run security tests");
  assert.ok(dbUp);
});

const ownerToken = () => jwt.sign({ sub: ownerId }, env.jwtSecret, { expiresIn: "10m" });
const outsiderToken = () => jwt.sign({ sub: outsiderId }, env.jwtSecret, { expiresIn: "10m" });

test("auth boundary: missing, garbage, and expired tokens are rejected", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const noToken = await app.inject({ method: "GET", url: "/v1/workspaces" });
  assert.equal(noToken.statusCode, 401);

  const garbage = await app.inject({ method: "GET", url: "/v1/workspaces", headers: auth("not-a-jwt") });
  assert.equal(garbage.statusCode, 401);

  const expired = jwt.sign({ sub: ownerId }, env.jwtSecret, { expiresIn: "-10s" });
  const res = await app.inject({ method: "GET", url: "/v1/workspaces", headers: auth(expired) });
  assert.equal(res.statusCode, 401);
});

test("owner creates a session in their workspace", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "POST",
    url: "/v1/interview-sessions",
    headers: auth(ownerToken()),
    payload: { workspaceId, consentStatus: "confirmed" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { id: string };
  sessionId = body.id;
  assert.ok(sessionId);
});

test("tenant isolation: an outsider cannot read, mutate, or export another user's session", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const paths = [
    ["GET", `/v1/interview-sessions/${sessionId}`],
    ["GET", `/v1/interview-sessions/${sessionId}/transcript`],
    ["GET", `/v1/interview-sessions/${sessionId}/insights`],
    ["POST", `/v1/interview-sessions/${sessionId}/complete`],
    ["POST", `/v1/interview-sessions/${sessionId}/export`],
    ["DELETE", `/v1/interview-sessions/${sessionId}`],
  ] as const;
  for (const [method, url] of paths) {
    const res = await app.inject({ method, url, headers: auth(outsiderToken()) });
    assert.ok(
      res.statusCode === 403 || res.statusCode === 404,
      `${method} ${url} must be denied for outsiders, got ${res.statusCode}`,
    );
  }

  const patch = await app.inject({
    method: "PATCH",
    url: `/v1/interview-sessions/${sessionId}`,
    headers: auth(outsiderToken()),
    payload: { title: "hijacked" },
  });
  assert.ok(patch.statusCode === 403 || patch.statusCode === 404, "PATCH must be denied");
});

test("tenant isolation: outsider cannot mint relay sessions for a workspace they are not a member of", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "POST",
    url: "/v1/stt/session",
    headers: auth(outsiderToken()),
    payload: { workspaceId },
  });
  assert.equal(res.statusCode, 403);
});

test("secret redaction: provider secret is sealed and never echoed by any response", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const create = await app.inject({
    method: "POST",
    url: "/v1/provider-connections",
    headers: auth(ownerToken()),
    payload: { workspaceId, provider: "groq", secret: SECRET_MATERIAL },
  });
  assert.equal(create.statusCode, 201);
  assert.ok(!create.body.includes(SECRET_MATERIAL), "create response must not contain the raw secret");
  assert.equal((create.json() as { secretRef?: string }).secretRef, undefined);
  assert.equal((create.json() as { hasSecret?: boolean }).hasSecret, true);

  const list = await app.inject({
    method: "GET",
    url: `/v1/provider-connections?workspaceId=${workspaceId}`,
    headers: auth(ownerToken()),
  });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(SECRET_MATERIAL), "list response must not contain the raw secret");

  // The sealed reference must not be reversible without the master key path.
  const stored = await prisma.providerConnection.findFirst({ where: { workspaceId, provider: "groq" } });
  assert.ok(stored?.secretRef);
  assert.ok(!stored.secretRef.includes(SECRET_MATERIAL), "stored reference is ciphertext, not plaintext");
});

test("relay session mints an HMAC token for the owner, or 402 when no STT provider is configured", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "POST",
    url: "/v1/stt/session",
    headers: auth(ownerToken()),
    payload: { workspaceId },
  });
  assert.ok([200, 402].includes(res.statusCode), `expected 200 or 402, got ${res.statusCode}`);
  if (res.statusCode === 200) {
    const body = res.json() as { session_token?: string; relay_ws_url?: string };
    assert.ok(body.session_token, "token present");
    assert.ok(body.relay_ws_url?.endsWith("/v1/stt/relay"));
  }
});

test("provider connect writes an audit event", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const events = await prisma.auditEvent.findMany({
    where: { workspaceId, eventType: "provider.connected" },
  });
  assert.ok(events.length >= 1, "provider.connected audit event recorded");
  const meta = JSON.stringify(events[0]?.metadataJson ?? {});
  assert.ok(!meta.includes(SECRET_MATERIAL), "audit metadata must not contain the secret");
});
