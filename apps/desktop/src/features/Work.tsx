import { useCallback, useEffect, useState } from "react";
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
  const { workspaceId, notify } = useStore();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runTaskId, setRunTaskId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("workflow_execution");
  const [instructions, setInstructions] = useState("");
  const [domains, setDomains] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [runUrl, setRunUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const flash = useCallback((m: string) => notify("success", m), [notify]);

  async function refresh() {
    if (!workspaceId) return;
    try {
      const [res, runsRes] = await Promise.all([
        api.verticalGet<{ tasks: TaskRow[] }>(VERTICAL, `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`),
        api.verticalGet<{ runs: RunRow[] }>(VERTICAL, `/agent-runs?workspaceId=${encodeURIComponent(workspaceId)}`).catch(() => ({ runs: [] as RunRow[] })),
      ]);
      setTasks(res.tasks ?? []);
      // Runs are durable (server-restored) — recent history survives restarts.
      setRuns(runsRes.runs ?? []);
      // Keep the run picker honest: follow the list; default to the first.
      setRunTaskId((cur) => (res.tasks?.some((t) => t.id === cur) ? cur : res.tasks?.[0]?.id ?? ""));
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { void refresh(); }, [workspaceId]);

  // Live run status: any non-terminal run polls every 3s — the panel updates
  // itself instead of waiting for a manual refresh click.
  useEffect(() => {
    const active = runs.some((r) => r.status === "running" || r.status === "pending" || r.status === "queued");
    if (!active) return;
    const t = setInterval(async () => {
      for (const r of runs.filter((x) => x.status === "running" || x.status === "pending" || x.status === "queued")) {
        try {
          const res = await api.verticalGet<{ run: RunRow }>(VERTICAL, `/agent-runs/${r.id}`);
          if (res.run?.status && res.run.status !== r.status) {
            setRuns((prev) => prev.map((x) => (x.id === r.id ? res.run : x)));
          }
        } catch { /* transient — next tick retries */ }
      }
    }, 3_000);
    return () => clearInterval(t);
  }, [runs]);

  async function create() {
    if (!workspaceId || !title.trim()) return;
    setBusy(true);
    try {
      const allowedDomains = domains.split(",").map((d) => d.trim()).filter(Boolean);
      await api.verticalPost(VERTICAL, "/tasks", {
        workspaceId, title, type, instructions, allowedDomains, autoApprove,
      });
      setTitle(""); setInstructions(""); setDomains(""); setAutoApprove(false);
      flash(allowedDomains.length === 0
        ? "Task created — domains blank, browser execution blocked until policy allows"
        : "Task created");
      void refresh();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function act(task: TaskRow, action: "assign" | "submit" | "review") {
    setBusy(true);
    try {
      const body = action === "submit" ? { origin: "human" } : action === "review" ? { decision: "approved" } : {};
      await api.verticalPost(VERTICAL, `/tasks/${task.id}/${action}`, body);
      flash(`${task.title}: ${action} done${action === "review" && task.autoApprove ? " (auto-approve policy)" : ""}`);
      void refresh();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function runBrowser(task: TaskRow) {
    if (!runUrl.trim()) {
      notify("error", "Enter the target URL first (must be inside the task's allowedDomains)");
      return;
    }
    setBusy(true);
    try {
      const res = await api.verticalPost<{ run: RunRow; approval?: string }>(VERTICAL, "/agent-runs", {
        workspaceId, taskId: task.id, url: runUrl,
      });
      setRuns((prev) => [res.run, ...prev].slice(0, 8));
      flash(`Agent run ${res.run.status}${res.run.status === "completed" ? "" : " — check recent runs"}`);
      void refresh();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function stopRun(run: RunRow) {
    try {
      await api.verticalPost(VERTICAL, `/agent-runs/${run.id}/stop`, {});
      notify("success", "Run stopped (kill switch)");
      setRuns((prev) => prev.map((r) => (r.id === run.id ? { ...r, status: "stopped" } : r)));
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteTask(task: TaskRow) {
    try {
      await api.verticalDelete(VERTICAL, `/tasks/${task.id}?workspaceId=${encodeURIComponent(workspaceId ?? "")}`);
      notify("success", `Task deleted: ${task.title}`);
      setConfirmDelete(null);
      void refresh();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setConfirmDelete(null);
    }
  }

  const runTask = tasks.find((t) => t.id === runTaskId);

  return (
    <div className="col">
      <PageHeader
        kicker="Velari Work"
        title="Tasks & automation"
        description="Author work, gate it with policy, run bounded browser automation with approval or auto-approve."
      />

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
          <input placeholder="https://example.com/path…" value={runUrl} onChange={(e) => setRunUrl(e.target.value)} />
          {tasks.length > 0 ? (
            <select value={runTaskId} onChange={(e) => setRunTaskId(e.target.value)}>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.type.replace(/_/g, " ")})</option>)}
            </select>
          ) : (
            <span className="small muted">Create a task first — runs execute a task's policy.</span>
          )}
          {runTask && (
            <span className="small muted">
              Policy: {runTask.allowedDomains?.length ? runTask.allowedDomains.join(", ") : "no domains — runs will be blocked"}
              {runTask.autoApprove ? " · auto-approve ON" : " · approval required"}
            </span>
          )}
          <button
            className="primary"
            disabled={busy || !runTask || !runUrl.trim()}
            onClick={() => runTask && void runBrowser(runTask)}
          >
            Start bounded run
          </button>
          {runs.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <span className="kicker" style={{ marginTop: 4 }}>Recent runs</span>
              {runs.slice(0, 8).map((r) => (
                <div key={r.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <span className="mono">{r.id.slice(0, 8)} · {r.inputJson?.url?.slice(0, 32) ?? ""}</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="badge">{r.status}</span>
                    {(r.status === "running" || r.status === "pending" || r.status === "queued") && (
                      <button className="ghost" onClick={() => void stopRun(r)}>Stop</button>
                    )}
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
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{t.title}</span>
                <span className="small muted mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.id.slice(0, 8)} · {t.type} · domains: {t.allowedDomains?.length ? t.allowedDomains.join(", ") : "[] (blocked)"}
                </span>
              </div>
              <div className="row" style={{ gap: 6, flex: "none" }}>
                <StatusPill status={t.status} />
                {t.status === "draft" && <button className="ghost" disabled={busy} onClick={() => void act(t, "assign")}>Assign</button>}
                {(t.status === "draft" || t.status === "assigned") && <button className="ghost" disabled={busy} onClick={() => void act(t, "submit")}>Submit</button>}
                {t.status === "submitted" && <button className="ghost" disabled={busy} onClick={() => void act(t, "review")}>Review</button>}
                {confirmDelete === t.id ? (
                  <>
                    <button className="ghost" style={{ color: "var(--danger)" }} disabled={busy} onClick={() => void deleteTask(t)}>Delete?</button>
                    <button className="ghost" onClick={() => setConfirmDelete(null)}>✕</button>
                  </>
                ) : (
                  <button className="ghost" style={{ opacity: 0.55 }} title="Delete task" onClick={() => setConfirmDelete(t.id)}>🗑</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
