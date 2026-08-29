/**
 * Vector recall integration tests (§5.1 P3): reindex + hybrid recall against
 * real pgvector. Skips cleanly when Postgres is unreachable.
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
const ownerEmail = `rag-owner-${suffix}@test.local`;
const outsiderEmail = `rag-out-${suffix}@test.local`;
let ownerId = "";
let outsiderId = "";
let workspaceId = "";
let sessionId = "";

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
  if (!dbUp) return;
  const owner = await prisma.user.create({ data: { email: ownerEmail } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail } });
  ownerId = owner.id;
  outsiderId = outsider.id;
  const ws = await prisma.workspace.create({ data: { name: `rag-ws-${suffix}` } });
  workspaceId = ws.id;
  await prisma.workspaceMember.create({ data: { workspaceId, userId: ownerId, role: "owner" } });
  const session = await prisma.interviewSession.create({
    data: { workspaceId, ownerUserId: ownerId, status: "completed", consentStatus: "confirmed" },
  });
  sessionId = session.id;
  const lines = [
    "I led the migration of our billing pipeline to an event-driven architecture.",
    "The hardest part was reconciling double-charges during the cutover window.",
    "We shipped a reconciliation service that compared ledger deltas hourly.",
  ];
  await prisma.transcriptSegment.createMany({
    data: lines.map((text, i) => ({
      sessionId,
      sequenceNo: i + 1,
      startedAtMs: i * 20_000,
      endedAtMs: (i + 1) * 20_000,
      text,
      confidence: 0.9,
      isFinal: true,
      source: "cloud_stt",
    })),
  });
});

after(async () => {
  if (dbUp) {
    await prisma.$executeRaw`DELETE FROM session_chunks WHERE session_id = ${sessionId}`;
    await prisma.auditEvent.deleteMany({ where: { workspaceId } });
    await prisma.transcriptSegment.deleteMany({ where: { sessionId } });
    await prisma.interviewSession.deleteMany({ where: { id: sessionId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  }
  await app.close();
  await prisma.$disconnect();
});

const ownerToken = () => jwt.sign({ sub: ownerId }, env.jwtSecret, { expiresIn: "10m" });
const outsiderToken = () => jwt.sign({ sub: outsiderId }, env.jwtSecret, { expiresIn: "10m" });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("db reachable (else recall suite skips)", (t) => {
  if (!dbUp) t.skip("postgres unreachable");
  assert.ok(dbUp);
});

test("reindex embeds final transcript chunks with the free provider", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "POST",
    url: `/v1/interview-sessions/${sessionId}/reindex`,
    headers: auth(ownerToken()),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { chunks: number; provider: string };
  assert.equal(body.provider, "lexical-hash", "free-first embedding provider");
  assert.ok(body.chunks >= 1, "chunks written");

  const stored = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM session_chunks WHERE session_id = ${sessionId}`;
  assert.equal(Number(stored[0]!.count), body.chunks);
});

test("hybrid recall returns relevant chunks for the owner", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "GET",
    url: `/v1/interview-sessions/${sessionId}/recall?q=reconciliation%20service`,
    headers: auth(ownerToken()),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { hits: { text: string; score: number }[] };
  assert.ok(body.hits.length >= 1, "at least one hit");
  assert.ok(
    body.hits.some((h) => h.text.includes("reconciliation")),
    "lexical path guarantees the keyword hit",
  );
  assert.ok(body.hits[0]!.score > 0);
});

test("outsider cannot reindex or recall another user's session", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const re = await app.inject({
    method: "POST",
    url: `/v1/interview-sessions/${sessionId}/reindex`,
    headers: auth(outsiderToken()),
  });
  assert.ok(re.statusCode === 403 || re.statusCode === 404, `reindex denied, got ${re.statusCode}`);
  const recall = await app.inject({
    method: "GET",
    url: `/v1/interview-sessions/${sessionId}/recall?q=x`,
    headers: auth(outsiderToken()),
  });
  assert.ok(recall.statusCode === 403 || recall.statusCode === 404, "recall denied");
});

test("recall requires a query", async (t) => {
  if (!dbUp) return t.skip("postgres unreachable");
  const res = await app.inject({
    method: "GET",
    url: `/v1/interview-sessions/${sessionId}/recall`,
    headers: auth(ownerToken()),
  });
  assert.equal(res.statusCode, 400);
});
