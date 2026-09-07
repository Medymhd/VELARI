/**
 * Session prep contexts (rival ModesManager reference-files parity): CV, job
 * description, notes, and drilled Q&As per session. Q&A entries are matched
 * against live interviewer questions for INSTANT prepared-answer recall
 * (no LLM latency). PDF extraction server-side via pdf-parse.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { assertMembership } from "./workspaces.js";
import { toJson } from "../db.js";

// CJS deps from an ESM module (package "type": "module") — createRequire is
// the sanctioned bridge. pdf-parse v2 (class API), mammoth (docx), xlsx.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PDFParse } = require("pdf-parse") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mammoth = require("mammoth") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX = require("xlsx") as any;

const KINDS = new Set(["cv", "jd", "notes", "qa"]);

/** Extract text from an uploaded file: pdf (pdf-parse v2), docx (mammoth),
 *  xls/xlsx/csv (SheetJS), txt/md as utf8. */
async function extractFile(filename: string, base64: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    await parser.destroy();
    return result.text.replace(/\u0000/g, "").trim();
  }

  if (lower.endsWith(".docx")) {
    const r = await mammoth.extractRawText({ buffer: buf });
    return String(r.value ?? "").trim();
  }

  if (lower.endsWith(".xls") || lower.endsWith(".xlsx") || lower.endsWith(".csv")) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const out: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      out.push(`## ${name}`);
      // rows as pipe-separated cells — readable by both the LLM and the user
      out.push(XLSX.utils.sheet_to_csv(sheet, { FS: " | " }));
    }
    return out.join("\n\n").trim();
  }

  return buf.toString("utf8");
}

export function contextRoutes(app: FastifyInstance, db: PrismaClient): void {
  app.post("/v1/interview-sessions/:id/context", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "session not found" });
    if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });

    const body = (req.body ?? {}) as {
      kind?: string;
      title?: string;
      content?: string;
      files?: { name: string; base64: string }[];
    };
    const kind = (body.kind ?? "").toLowerCase();
    if (!KINDS.has(kind)) {
      return reply.status(400).send({ error: `kind must be one of: ${[...KINDS].join(", ")}` });
    }

    const created: { id: string; title: string }[] = [];

    // Text paste / typed entry
    const pasted = (body.content ?? "").trim();
    if (pasted) {
      const row = await db.sessionContext.create({
        data: {
          sessionId: id,
          kind,
          title: (body.title ?? `${kind} note`).slice(0, 120),
          content: pasted.slice(0, 40_000),
        },
      });
      created.push({ id: row.id, title: row.title });
    }

    // Uploaded files (txt/md/pdf — pdf parsed server-side)
    for (const f of body.files ?? []) {
      if (!f.base64) continue;
      try {
        const text = await extractFile(f.name, f.base64);
        if (text.length < 10) continue;
        const row = await db.sessionContext.create({
          data: {
            sessionId: id,
            kind,
            title: (f.name || `${kind} file`).slice(0, 120),
            content: text.slice(0, 60_000),
          },
        });
        created.push({ id: row.id, title: row.title });
      } catch (e) {
        return reply.status(400).send({ error: `failed to extract ${f.name}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    if (created.length === 0) {
      return reply.status(400).send({ error: "nothing to add — provide content or files" });
    }
    return reply.status(201).send(toJson({ created }));
  });

  app.get("/v1/interview-sessions/:id/context", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "session not found" });
    if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });
    const rows = await db.sessionContext.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    });
    return reply.send(toJson(rows));
  });

  app.delete("/v1/interview-sessions/:id/context/:ctxId", async (req, reply) => {
    const { id, ctxId } = req.params as { id: string; ctxId: string };
    const session = await db.interviewSession.findUnique({ where: { id } });
    if (!session) return reply.status(404).send({ error: "session not found" });
    if (session.ownerUserId !== req.user!.userId) return reply.status(403).send({ error: "forbidden" });
    await db.sessionContext.deleteMany({ where: { id: ctxId, sessionId: id } });
    return reply.send({ deleted: true });
  });
}
