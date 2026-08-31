/**
 * Profile Intelligence (rival `ProfileTreeService` parity, compact) +
 * verified code execution (rival codeVerification cloud-runner parity, via
 * the public Piston API) + browser-capture ingestion (rival companion
 * extension parity).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CircuitBreakerRegistry } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "../ai/runtime.js";
import { assertMembership } from "./workspaces.js";
import { toJson } from "../db.js";

const breakers = new CircuitBreakerRegistry();

export function profileRoutes(app: FastifyInstance, db: PrismaClient): void {
  /**
   * Analyze a pasted resume into a structured persona. The persona feeds the
   * live coach ("Candidate role/context") so answers cite real background
   * instead of inventing it.
   */
  app.post("/v1/profile/analyze", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as { workspaceId?: string; resumeText?: string };
    const text = (body.resumeText ?? "").trim();
    if (!body.workspaceId || text.length < 40) {
      return reply.status(400).send({ error: "workspaceId and resumeText (min 40 chars) are required" });
    }
    if (!(await assertMembership(db, userId, body.workspaceId))) {
      return reply.status(403).send({ error: "not a member of this workspace" });
    }

    const cfg = await loadWorkspaceAiConfig(db, body.workspaceId);
    const outcome = await executeRouted(
      { db, breakers },
      cfg,
      body.workspaceId,
      null,
      {
        taskClass: "deep_analysis",
        privacyMode: cfg.privacyMode,
        maxLatencyMs: 45_000,
        messages: [
          {
            role: "system",
            content: [
              "Extract a structured candidate persona from the resume text below. Respond ONLY with JSON matching:",
              '{"role":string,"seniority":string,"skills":string[],"experienceHighlights":string[],"domainTerms":string[],"education":string}',
              "role: title to say aloud (e.g. 'Senior backend engineer'). seniority: junior/mid/senior/staff/principal/lead.",
              "skills: max 8 concrete technologies/domains. experienceHighlights: max 5 one-line achievements with numbers where the resume provides them.",
              "domainTerms: up to 5 domain vocabulary words to echo. education: one line or empty.",
              "Ground EVERY field in the resume text — never invent. Missing → empty string/array.",
            ].join("\n"),
          },
          { role: "user", content: text.slice(0, 12_000) },
        ],
      } as never,
    );

    let persona: Record<string, unknown> | null = null;
    if (outcome.ok && outcome.structured) persona = outcome.structured as Record<string, unknown>;
    else if (outcome.ok && outcome.text) {
      try {
        persona = JSON.parse(outcome.text.replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown>;
      } catch {
        persona = null;
      }
    }
    if (!persona?.role) {
      // Deterministic fallback: crude keyword extraction so the feature still works offline.
      const words = text.toLowerCase().match(/[a-z+#.]{3,}/g) ?? [];
      const stop = new Set(["and", "the", "with", "for", "from", "that", "this", "have", "has", "was", "were", "our", "their", "will", "been", "are", "you", "your", "into", "over", "under"]);
      const freq = new Map<string, number>();
      for (const w of words) if (!stop.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
      const skills = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
      persona = {
        role: "Candidate",
        seniority: "mid",
        skills,
        experienceHighlights: text.split(/\n+/).filter((l) => l.trim().length > 20).slice(0, 3),
        domainTerms: skills.slice(0, 3),
        education: "",
      };
    }

    const saved = await db.profilePersona.upsert({
      where: { workspaceId: body.workspaceId },
      update: { personaJson: persona as object },
      create: { workspaceId: body.workspaceId, personaJson: persona as object },
    });
    return reply.send(toJson(saved));
  });

  app.get("/v1/profile", async (req) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return null;
    const row = await db.profilePersona.findUnique({ where: { workspaceId } });
    return toJson(row);
  });

  app.delete("/v1/profile", async (req, reply) => {
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) return reply.status(400).send({ error: "workspaceId required" });
    if (!(await assertMembership(db, req.user!.userId, workspaceId))) {
      return reply.status(403).send({ error: "owner or admin required" });
    }
    await db.profilePersona.deleteMany({ where: { workspaceId } });
    return reply.send({ deleted: true });
  });

  /**
   * Verified code execution (rival codeVerification cloud-runner parity):
   * runs model-emitted code against the public Piston API — no local
   * execution, no shell, one kill switch (CODE_VERIFY=off).
   */
  app.post("/v1/code/verify", async (req, reply) => {
    if ((process.env.CODE_VERIFY ?? "").toLowerCase() === "off") {
      return reply.status(403).send({ error: "code verification disabled (CODE_VERIFY=off)" });
    }
    const body = (req.body ?? {}) as {
      language?: string;
      code?: string;
      stdin?: string;
    };
    const code = (body.code ?? "").slice(0, 20_000);
    if (!body.language || !code) return reply.status(400).send({ error: "language and code are required" });

    // Piston accepts a subset of aliases; map our common names.
    const aliases: Record<string, string> = {
      python: "python", python3: "python", javascript: "javascript", js: "javascript",
      typescript: "typescript", ts: "typescript", java: "java", cpp: "c++", "c++": "c++",
      c: "c", go: "go", rust: "rust",
    };
    const pistonLang = aliases[body.language.toLowerCase()];
    if (!pistonLang) return reply.status(400).send({ error: `unsupported language: ${body.language}` });

    try {
      const res = await fetch("https://emkc.org/api/v2/piston/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language: pistonLang,
          version: "*",
          files: [{ name: `main.${body.language === "python" ? "py" : body.language}`, content: code }],
          stdin: (body.stdin ?? "").slice(0, 4_000),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return reply.send({ ok: false, error: `piston HTTP ${res.status}` });
      const j = (await res.json()) as {
        run?: { stdout?: string; stderr?: string; code?: number; output?: string };
        compile?: { stderr?: string };
      };
      const compileErr = j.compile?.stderr;
      return reply.send({
        ok: !compileErr && (j.run?.code ?? 0) === 0,
        stdout: (j.run?.stdout ?? "").slice(0, 4_000),
        stderr: (j.run?.stderr ?? "").slice(0, 2_000),
        compileError: compileErr?.slice(0, 2_000),
      });
    } catch (e) {
      return reply.send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Browser-companion ingestion (rival Ctrl+Y page capture parity): the
   * Chrome extension posts page text + URL; it lands on the user's live
   * session as a web_context insight the Review screen renders.
   */
  app.post("/v1/context/capture", async (req, reply) => {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as { text?: string; url?: string; title?: string };
    const text = (body.text ?? "").trim();
    if (text.length < 10) return reply.status(400).send({ error: "text (min 10 chars) required" });

    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    if (!membership) return reply.status(403).send({ error: "no workspace membership" });
    const liveSession = await db.interviewSession.findFirst({
      where: { ownerUserId: userId, status: "live" },
      orderBy: { startedAt: "desc" },
    });

    const insight = await db.sessionInsight.create({
      data: {
        id: randomUUID(),
        sessionId: liveSession?.id ?? "unassigned",
        type: "web_context",
        sourceSegmentIds: [],
        contentJson: {
          text: text.slice(0, 8_000),
          url: body.url ?? "",
          title: body.title ?? "",
        },
      },
    });
    return reply.status(201).send(toJson({ id: insight.id, attachedSessionId: liveSession?.id ?? null }));
  });

  /** Desktop polls this while live to surface captured web context. */
  app.get("/v1/context/capture", async (req) => {
    const userId = req.user!.userId;
    const since = (req.query as { since?: string }).since;
    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    if (!membership) return [];
    const liveSession = await db.interviewSession.findFirst({
      where: { ownerUserId: userId, status: "live" },
      orderBy: { startedAt: "desc" },
    });
    if (!liveSession) return [];
    const rows = await db.sessionInsight.findMany({
      where: {
        sessionId: liveSession.id,
        type: "web_context",
        ...(since ? { createdAt: { gt: new Date(since) } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return toJson(rows);
  });
}
