import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedDomain, requiresApproval } from "./types.js";
import { vertical } from "./backend.js";
import type { RouteRegistrar, ReplyLike } from "@app/agent-sdk";

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

// ── Backend route tests with an in-memory fake db + registrar ────────────

interface FakeRow {
  id: string;
  workspaceId: string;
  status: string;
  allowedDomains: string[];
  autoApprove: boolean;
  policyVersion: string;
  origin?: string;
  reviewState?: string;
  createdAt: Date;
  [key: string]: unknown;
}

/** Minimal Prisma-shaped fake covering workTask/workSubmission/auditEvent. */
function makeDb() {
  let taskSeq = 0;
  let subSeq = 0;
  const tasks: FakeRow[] = [];
  const submissions: FakeRow[] = [];
  const audits: FakeRow[] = [];
  const id = () => `id-${++taskSeq}-${Math.random().toString(36).slice(2, 6)}`;

  const db = {
    workspaceMember: {
      findUnique: async (args: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) =>
        ({ workspaceId: args.where.workspaceId_userId.workspaceId, userId: args.where.workspaceId_userId.userId }),
    },
    workTask: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: FakeRow = {
          id: id(),
          status: "draft",
          allowedDomains: [],
          policyVersion: "v1",
          createdAt: new Date(),
          ...args.data,
        } as unknown as FakeRow;
        tasks.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) => tasks.find((t) => t.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = tasks.find((x) => x.id === args.where.id)!;
        Object.assign(t, args.data);
        return t;
      },
      findMany: async () => tasks,
    },
    workSubmission: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: FakeRow = { id: `sub-${++subSeq}`, reviewState: "unreviewed", createdAt: new Date(), ...args.data } as FakeRow;
        submissions.push(row);
        return row;
      },
      findFirst: async () => submissions.at(-1) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = submissions.find((x) => x.id === args.where.id)!;
        Object.assign(s, args.data);
        return s;
      },
      findMany: async () => submissions,
    },
    auditEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data as FakeRow);
        return args.data;
      },
    },
  };
  return { db, tasks, submissions, audits };
}

/** Fake registrar capturing routes with :param matching; invoke(method, path, req) runs handlers. */
function makeRegistrar(db: unknown) {
  const routes = new Map<
    string,
    { regex: RegExp; paramNames: string[]; handler: (req: unknown, reply: ReplyLike) => unknown }
  >();
  const compile = (path: string) => {
    const paramNames = [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
    return { regex: new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, "([^/]+)")}$`), paramNames };
  };
  const registrar: RouteRegistrar & { db: unknown } = {
    get(path, handler) {
      routes.set(`GET ${path}`, { ...compile(`GET ${path}`), handler: handler as never });
      return null;
    },
    post(path, handler) {
      routes.set(`POST ${path}`, { ...compile(`POST ${path}`), handler: handler as never });
      return null;
    },
    patch(path, handler) {
      routes.set(`PATCH ${path}`, { ...compile(`PATCH ${path}`), handler: handler as never });
      return null;
    },
    delete(path, handler) {
      routes.set(`DELETE ${path}`, { ...compile(`DELETE ${path}`), handler: handler as never });
      return null;
    },
    db,
  };
  const reply = () => {
    const r: { code?: number; body?: unknown } = {};
    return {
      status(code: number) {
        r.code = code;
        return { send: (v: unknown) => ((r.body = v), v) };
      },
      send(v: unknown) {
        r.body = v;
        return v;
      },
    } as ReplyLike & { code?: number; body?: unknown };
  };
  return {
    registrar,
    async invoke(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, req: Record<string, unknown> = {}) {
      for (const { regex, paramNames, handler } of routes.values()) {
        const match = regex.exec(`${method} ${path}`);
        if (!match) continue;
        const params: Record<string, string> = {};
        paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1]!)));
        return handler({ user: { userId: "u1" }, params, ...req }, reply()) as unknown;
      }
      throw new Error(`route not found: ${method} ${path}`);
    },
    reply,
  };
}

test("task lifecycle persists through the fake db: create → assign → submit → review", async () => {
  const { db, tasks, submissions, audits } = makeDb();
  const { registrar, invoke } = makeRegistrar(db);
  vertical.registerRoutes?.(registrar as never, { db });

  const created = (await invoke("POST", "/tasks", {
    body: { workspaceId: "ws-1", title: "Code review task", type: "code_review", allowedDomains: ["github.com"], autoApprove: false },
  })) as { task: { id: string; status: string; createdBy: string } };
  assert.equal(created.task.status, "draft");
  assert.equal(created.task.createdBy, "u1", "createdBy comes from the JWT user, not the body");

  await invoke("POST", `/tasks/${created.task.id}/assign`);
  await invoke("POST", `/tasks/${created.task.id}/submit`, { body: { origin: "human", content: "done" } });

  const review = (await invoke("POST", `/tasks/${created.task.id}/review`, { body: { decision: "approved" } })) as {
    task: { status: string };
    autoApproved: boolean;
  };
  assert.equal(review.task.status, "approved");
  assert.equal(review.autoApproved, false, "task was created without autoApprove");
  assert.equal(tasks.length, 1);
  assert.equal(submissions.length, 1, "submission row persisted");
  assert.equal(submissions[0]!.reviewState, "approved");
  assert.equal(audits.length, 2, "submit + review audited");
});

test("browser/execute: blank allowlist blocks; allowlisted + autoApprove auto-approves", async () => {
  const { db, tasks } = makeDb();
  const { registrar, invoke } = makeRegistrar(db);
  vertical.registerRoutes?.(registrar as never, { db });

  const t1 = (await invoke("POST", "/tasks", {
    body: { workspaceId: "ws-1", type: "browser_task_execution", allowedDomains: [], autoApprove: false },
  })) as { task: { id: string } };
  const blocked = (await invoke("POST", "/browser/execute", {
    body: { taskId: t1.task.id, url: "https://outlierclone.io/x" },
  })) as { error?: string; allowedDomains?: string[] };
  assert.equal(blocked.error, "domain not allowlisted", "blank allowlist blocks (policy from the task record)");
  assert.deepEqual(blocked.allowedDomains, []);

  const t2 = (await invoke("POST", "/tasks", {
    body: { workspaceId: "ws-1", type: "browser_task_execution", allowedDomains: ["outlierclone.io"], autoApprove: true },
  })) as { task: { id: string } };
  const allowed = (await invoke("POST", "/browser/execute", {
    body: { taskId: t2.task.id, url: "https://outlierclone.io/x", credentialRef: "apikey:sk-test" },
  })) as { approval: string; credentialKind: string };
  assert.equal(allowed.approval, "auto_approved");
  assert.equal(allowed.credentialKind, "api_key");
  assert.equal(tasks.length, 2);
});

test("browser/execute with manual approval creates a pending approval_requests row", async () => {
  const { db, tasks } = makeDb();
  const approvals: { status: string }[] = [];
  const extended = Object.assign(db, {
    approvalRequest: {
      create: async (args: { data: { status: string } }) => {
        const row = { id: `appr-${approvals.length + 1}`, status: args.data.status };
        approvals.push(row);
        return row;
      },
    },
  });
  const { registrar, invoke } = makeRegistrar(extended);
  vertical.registerRoutes?.(registrar as never, { db: extended });

  const t = (await invoke("POST", "/tasks", {
    body: { workspaceId: "ws-1", type: "browser_task_execution", allowedDomains: ["outlierclone.io"], autoApprove: false },
  })) as { task: { id: string } };
  const res = (await invoke("POST", "/browser/execute", {
    body: { taskId: t.task.id, url: "https://outlierclone.io/x" },
  })) as { approval: string; approvalId: string | null };

  assert.equal(res.approval, "pending", "external_write without autoApprove → pending approval");
  assert.ok(res.approvalId, "approval id returned");
  assert.equal(approvals[0]!.status, "pending");
});
