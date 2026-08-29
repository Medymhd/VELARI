// Debug harness — replicates work.test.ts lifecycle with logging.
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { vertical } = req("./dist/index.js");

function makeDb() {
  let taskSeq = 0;
  let subSeq = 0;
  const tasks = [];
  const submissions = [];
  const audits = [];
  const id = () => `id-${++taskSeq}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    audits,
    tasks,
    submissions,
    db: {
      workspaceMember: { findUnique: async () => ({ ok: true }) },
      workTask: {
        create: async (a) => {
          const r = { id: id(), status: "draft", allowedDomains: [], policyVersion: "v1", createdAt: new Date(), ...a.data };
          tasks.push(r);
          return r;
        },
        findUnique: async (a) => tasks.find((t) => t.id === a.where.id) ?? null,
        update: async (a) => {
          const t = tasks.find((x) => x.id === a.where.id);
          if (!t) throw new Error(`task not found in fake: ${a.where.id}`);
          Object.assign(t, a.data);
          return t;
        },
        findMany: async () => tasks,
      },
      workSubmission: {
        create: async (a) => {
          const r = { id: `sub-${++subSeq}`, reviewState: "unreviewed", createdAt: new Date(), ...a.data };
          submissions.push(r);
          return r;
        },
        findFirst: async () => submissions.at(-1) ?? null,
        update: async (a) => {
          const s = submissions.find((x) => x.id === a.where.id);
          if (!s) throw new Error(`submission not found in fake: ${a.where.id}`);
          Object.assign(s, a.data);
          return s;
        },
        findMany: async () => submissions,
      },
      auditEvent: { create: async (a) => { audits.push(a.data); return a.data; } },
    },
  };
}

const { db, tasks, submissions, audits } = makeDb();
const routes = new Map();
const registrar = {
  get(p, h) { routes.set(`GET ${p}`, h); return null; },
  post(p, h) { routes.set(`POST ${p}`, h); return null; },
  patch(p, h) { routes.set(`PATCH ${p}`, h); return null; },
  delete(p, h) { routes.set(`DELETE ${p}`, h); return null; },
};
vertical.registerRoutes(registrar, { db });
console.log("routes:", [...routes.keys()].join(" | "));

const reply = () => {
  const r = {};
  return {
    status(c) { return { send: (v) => { r.body = v; return v; } }; },
    send: (v) => { r.body = v; return v; },
    get body() { return r.body; },
  };
};

async function invoke(method, path, req = {}) {
  for (const [key, handler] of routes) {
    const [m, ...seg] = key.split(" ");
    if (m !== method) continue;
    const parts = seg[0].split("/");
    const actual = path.split("/");
    if (parts.length !== actual.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = actual[i];
      else if (parts[i] !== actual[i]) { ok = false; break; }
    }
    if (!ok) continue;
    const r = reply();
    return { response: await handler({ user: { userId: "u1" }, params, ...req }, r), body: r.body };
  }
  return { notFound: true };
}

const created = await invoke("POST", "/tasks", { body: { workspaceId: "ws-1", title: "T", type: "code_review" } });
console.log("create →", JSON.stringify(created).slice(0, 140));
const taskId = created.body?.task?.id ?? created.response?.task?.id;
console.log("taskId:", taskId);
const assigned = await invoke("POST", `/tasks/${taskId}/assign`);
console.log("assign →", JSON.stringify(assigned.body ?? assigned).slice(0, 100));
const submitted = await invoke("POST", `/tasks/${taskId}/submit`, { body: { origin: "human", content: "done" } });
console.log("submit →", JSON.stringify(submitted.body ?? submitted).slice(0, 120));
const reviewed = await invoke("POST", `/tasks/${taskId}/review`, { body: { decision: "approved" } });
console.log("review →", JSON.stringify(reviewed.body ?? reviewed).slice(0, 160));
console.log("audits:", audits.length, "submissions:", submissions.length);
