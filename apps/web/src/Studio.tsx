import { useEffect, useState } from "react";
import { PageHeader, StatusPill } from "@app/ui";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787/v1";

function token() { return localStorage.getItem("app_token"); }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string> || {}) };
  const t = token(); if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, { ...init, headers });
  const txt = await r.text(); const body = txt ? JSON.parse(txt) : {};
  if (!r.ok) throw new Error((body as { error?: string }).error ?? String(r.status));
  return body as T;
}

const TASK_TYPES = [
  "text_classification", "document_extraction", "image_annotation", "video_annotation",
  "audio_transcription", "audio_quality_review", "rubric_based_assessment",
  "research_synthesis", "policy_compliance_review", "data_validation",
  "customer_workflow_execution", "code_review", "workflow_execution", "browser_task_execution",
] as const;

interface TaskRow { id: string; title: string | null; status: string; type: string }
interface RubricRow { id: string; title: string; version: number; status: string }

export default function Studio() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [rubrics, setRubrics] = useState<RubricRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [taskTitle, setTaskTitle] = useState("");
  const [taskType, setTaskType] = useState<string>("text_classification");
  const [taskInstructions, setTaskInstructions] = useState("");
  const [taskDomains, setTaskDomains] = useState("");
  const [taskAutoApprove, setTaskAutoApprove] = useState(false);

  const [rubricTitle, setRubricTitle] = useState("");
  const [rubricCriteria, setRubricCriteria] = useState("Accuracy|Description of accuracy criterion|3\nCompleteness|Was the work complete?|2");

  useEffect(() => {
    const t = token(); if (!t) return;
    try {
      const payload = JSON.parse(atob(t.split(".")[1]!)) as { sub?: string };
      if (payload.sub) void loadWorkspaces(payload.sub);
    } catch { /* ignore */ }
  }, []);

  async function loadWorkspaces(_userId: string) {
    try {
      const ws = await api<{ id: string; name: string }[]>("/workspaces");
      if (ws.length > 0) {
        setWorkspaceId(ws[0]!.id);
        const t = await api<{ tasks?: TaskRow[] }>(`/verticals/work/tasks?workspaceId=${ws[0]!.id}`).catch(() => ({ tasks: [] }));
        setTasks(t.tasks ?? []);
      }
    } catch { /* silent */ }
  }

  async function createTask() {
    if (!workspaceId || !taskTitle) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const allowedDomains = taskDomains.split(",").map((d) => d.trim()).filter(Boolean);
      const res = await api<{ task: TaskRow }>("/verticals/work/tasks", {
        method: "POST",
        body: JSON.stringify({
          workspaceId, title: taskTitle, type: taskType,
          instructions: taskInstructions, allowedDomains, autoApprove: taskAutoApprove,
        }),
      });
      setTasks((prev) => [res.task, ...prev]);
      setMsg(`Task created: ${res.task.id.slice(0, 8)}`);
      setTaskTitle(""); setTaskInstructions(""); setTaskDomains("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createRubric() {
    if (!workspaceId || !rubricTitle) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const criteria = rubricCriteria.split("\n").filter(Boolean).map((line) => {
        const [name, description, weight] = line.split("|").map((s) => s.trim());
        return { name: name ?? "", description: description ?? "", weight: Number(weight ?? "1") };
      });
      const res = await api<{ rubric: RubricRow }>("/verticals/work/rubrics", {
        method: "POST",
        body: JSON.stringify({ workspaceId, title: rubricTitle, criteria }),
      });
      setRubrics((prev) => [res.rubric, ...prev]);
      setMsg(`Rubric created: ${res.rubric.id.slice(0, 8)}`);
      setRubricTitle("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col">
      <PageHeader
        kicker="Studio"
        title="Work Studio — author tasks and rubrics"
        description="Create real work, define rubrics, set policy. Everything is tenanted, policy-gated, and audited."
      />
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}
      {msg && <span className="small" style={{ color: "var(--success)" }}>{msg}</span>}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="card col">
          <span className="kicker">Create work task</span>
          <input placeholder="Task title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
          <textarea placeholder="Instructions" value={taskInstructions} onChange={(e) => setTaskInstructions(e.target.value)} rows={3} />
          <input placeholder="Allowed domains (comma-separated, blank = blocked)" value={taskDomains} onChange={(e) => setTaskDomains(e.target.value)} />
          <label className="row small">
            <input type="checkbox" checked={taskAutoApprove} onChange={(e) => setTaskAutoApprove(e.target.checked)} style={{ width: 16, height: 16 }} />
            Auto-approve agent output (skips human review)
          </label>
          <button className="primary" disabled={busy || !taskTitle} onClick={() => void createTask()}>Create task</button>
        </div>

        <div className="card col">
          <span className="kicker">Create rubric</span>
          <input placeholder="Rubric title" value={rubricTitle} onChange={(e) => setRubricTitle(e.target.value)} />
          <textarea
            placeholder={"Criteria (one per line: name|description|weight)\nAccuracy|Was the answer factually correct?|3\nCompleteness|Did it address all parts?|2"}
            value={rubricCriteria} onChange={(e) => setRubricCriteria(e.target.value)} rows={5}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
          <button className="primary" disabled={busy || !rubricTitle} onClick={() => void createRubric()}>Create rubric</button>
        </div>
      </div>

      <div className="divider" />

      {tasks.length > 0 && (
        <div className="card col">
          <span className="kicker">Tasks ({tasks.length})</span>
          {tasks.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 550, fontSize: 13 }}>{t.title}</span>
                <span className="small muted mono">{t.id.slice(0, 8)} · {t.type}</span>
              </div>
              <StatusPill status={t.status} />
            </div>
          ))}
        </div>
      )}

      {rubrics.length > 0 && (
        <div className="card col">
          <span className="kicker">Rubrics ({rubrics.length})</span>
          {rubrics.map((r) => (
            <div key={r.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <span style={{ fontWeight: 550 }}>{r.title}</span>
              <span className="badge">v{r.version} · {r.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
