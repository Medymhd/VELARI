import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { PageHeader, StatusPill, Toggle } from "@app/ui";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  type: string;
  allowedDomains?: string[];
  autoApprove?: boolean;
}
interface RunRow { id: string; status: string; inputJson?: { url?: string } }

const VERTICAL = "work";
const TASK_TYPES = [
  "workflow_execution", "browser_task_execution", "data_validation", "research_synthesis",
  "document_extraction", "text_classification", "code_review", "policy_compliance_review",
];

export default function Work() {
  const { workspaceId } = useStore();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("workflow_execution");
  const [instructions, setInstructions] = useState("");
  const [domains, setDomains] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [runUrl, setRunUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!workspaceId) return;
    try {
      const res = await api.verticalGet<{ tasks: TaskRow[] }>(VERTICAL, `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`);
      setTasks(res.tasks ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => { void refresh(); }, [workspaceId]);

  function flash(m: string) { setMsg(m); setErr(null); }

  async function create() {
    if (!workspaceId || !title.trim()) return;
    setBusy(true); setErr(null);
    try {
      const allowedDomains = domains.split(",").map((d) => d.trim()).filter(Boolean);
      await api.verticalPost(VERTICAL, "/tasks", {
        workspaceId, title, type, instructions, allowedDomains, autoApprove,
      });
      setTitle(""); setInstructions(""); setDomains(""); setAutoApprove(false);
      flash(`Task created${allowedDomains.length === 0 ? " — domains blank, browser execution blocked until policy allows" : ""}`);
      void refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function act(task: TaskRow, action: "assign" | "submit" | "review") {
    setBusy(true); setErr(null);
    try {
      const body = action === "submit" ? { origin: "human" } : action === "review" ? { decision: "approved" } : {};
      await api.verticalPost(VERTICAL, `/tasks/${task.id}/${action}`, body);
      flash(`${task.title}: ${action} done${action === "review" && task.autoApprove ? " (auto-approve policy)" : ""}`);
      void refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function runBrowser(task: TaskRow) {
    if (!runUrl.trim()) { setErr("Enter the target URL first (must be inside the task's allowedDomains)"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.verticalPost<{ run: RunRow; approval?: string }>(VERTICAL, "/agent-runs", {
        taskId: task.id, url: runUrl,
      });
      setRuns((prev) => [res.run, ...prev]);
      flash(`Agent run ${res.run.status}`);
      void refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function stopRun(run: RunRow) {
    try {
      await api.verticalPost(VERTICAL, `/agent-runs/${run.id}/stop`, {});
      flash("Run stopped (kill switch)");
      setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, status: "stopped" } : r)));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="col">
      <PageHeader
        kicker="Velari Work"
        title="Tasks & automation"
        description="Author work, gate it with policy, run bounded browser automation with approval or auto-approve."
      />
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}
      {msg && <span className="small" style={{ color: "var(--success)" }}>{msg}</span>}

      <div className="grid" style={{ gridTemplateColumns: "1.1fr 0.9fr" }}>
        <div className="card col">
          <span className="kicker">Create task</span>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
          <textarea placeholder="Instructions" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <input
            placeholder="Allowed domains (comma-separated, blank = browser execution blocked)"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
          />
          <Toggle checked={autoApprove} onChange={setAutoApprove} label="Auto-approve agent output (skips human review — audited)" />
          <button className="primary" disabled={busy || !title.trim()} onClick={() => void create()}>Create task</button>
        </div>

        <div className="card col">
          <span className="kicker">Browser agent run</span>
          <span className="small muted">Runs are policy-checked against the task's allowedDomains; external_write requires an approved approval_requests row unless the task auto-approves.</span>
          <input placeholder="https://outlierclone.io/…" value={runUrl} onChange={(e) => setRunUrl(e.target.value)} />
          {tasks.length > 0 && (
            <select value={tasks[0]!.id} onChange={() => { /* single-task MVP: first task drives the run */ }}>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          )}
          <button className="primary" disabled={busy || tasks.length === 0} onClick={() => void runBrowser(tasks[0]!)}>
            Start bounded run
          </button>
          {runs.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              {runs.slice(0, 5).map((r) => (
                <div key={r.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <span className="mono">{r.id.slice(0, 8)} · {r.inputJson?.url?.slice(0, 32) ?? ""}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="badge">{r.status}</span>
                    {r.status === "running" && <button className="ghost" onClick={() => void stopRun(r)}>Stop</button>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card col">
        <span className="kicker">Tasks ({tasks.length})</span>
        {tasks.length === 0 && <span className="small muted">No tasks yet — create the first one above.</span>}
        {tasks.map((t) => (
          <div key={t.id} className="col" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{t.title}</span>
                <span className="small muted mono">
                  {t.id.slice(0, 8)} · {t.type} · domains: {t.allowedDomains?.length ? t.allowedDomains.join(", ") : "[] (blocked)"}
                </span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <StatusPill status={t.status} />
                {t.status === "draft" && <button className="ghost" disabled={busy} onClick={() => void act(t, "assign")}>Assign</button>}
                {(t.status === "draft" || t.status === "assigned") && <button className="ghost" disabled={busy} onClick={() => void act(t, "submit")}>Submit</button>}
                {t.status === "submitted" && <button className="ghost" disabled={busy} onClick={() => void act(t, "review")}>Review</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
