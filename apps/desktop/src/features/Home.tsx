import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, MotionCard, PageHeader, Skeleton, Sparkline, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };

export default function Home() {
  const { workspaceId, setSession, setScreen, clearAuth, resetLive, notify } = useStore();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    if (!workspaceId) return;
    try {
      const list = await api.listSessions(workspaceId);
      setSessions(list as never[]);
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [workspaceId]);

  function toggleSelect(id: string) {
    setConfirmBatch(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Batch delete: transcripts, insights, artifacts AND prep materials cascade
   *  server-side; story-bank and answer-cache rows stay (workspace memory). */
  async function deleteSelected() {
    if (selected.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const ids = [...selected].filter((id) => sessions.find((s) => s.id === id)?.status !== "live");
      let failed = 0;
      for (const id of ids) {
        try {
          await api.deleteSession(id);
        } catch {
          failed += 1;
        }
      }
      setSelected(new Set());
      setConfirmBatch(false);
      await refresh();
      notify(failed === 0 ? "success" : "error", failed === 0 ? `Deleted ${ids.length} session${ids.length === 1 ? "" : "s"}` : `Deleted ${ids.length - failed}, ${failed} failed`);
    } finally {
      setDeleting(false);
    }
  }

  const selectableCount = sessions.filter((s) => s.status !== "live").length;

  async function create() {
    if (!workspaceId) return;
    setCreating(true);
    try {
      const s = await api.createSession({ workspaceId, title: title || null, consentStatus: "confirmed" });
      setTitle("");
      resetLive(); // a new session starts clean — never inherits the previous one's transcript/insights
      setSession(s.id, "draft");
      setScreen("live");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setCreating(false);
    }
  }

  if (!workspaceId) {
    return (
      <EmptyState
        title="No workspace selected"
        description="Sign in from onboarding to create or open a workspace."
        action={<button onClick={clearAuth}>Sign out</button>}
      />
    );
  }

  const live = sessions.filter((s) => s.status === "live").length;
  const completed = sessions.filter((s) => s.status === "completed").length;
  const sparkData = sessions.map((_, i) => sessions.length - i); // cumulative trend

  return (
    <div className="col">
      <PageHeader
        kicker="Interview intelligence"
        title="Sessions"
        description="Create a session, capture both sides of the conversation, review what mattered."
        actions={
          <>
            <button className="ghost" onClick={() => void refresh()}>Refresh</button>
            <button className="primary" disabled={creating} onClick={() => void create()}>{creating ? "Creating…" : "New session"}</button>
          </>
        }
      />

      <div className="stats stagger">
        <MotionCard delay={0.03}>
          <div className="stat premium">
            <span className="label">Total</span>
            <span className="value grad">{sessions.length}</span>
            <Sparkline data={sessions.map((_, i) => sessions.length - i)} />
            <span className="stat-trend">↗ {sessions.length} sessions</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.06}>
          <div className="stat">
            <span className="label">Live</span>
            <span className="value">{live}</span>
            <span className="small muted">{live > 0 ? "actively running • pulse" : "none active"}</span>
            {live > 0 && <div className="waveform" style={{ marginTop: 6 }}><span></span><span></span><span></span><span></span><span></span></div>}
          </div>
        </MotionCard>
        <MotionCard delay={0.09}>
          <div className="stat">
            <span className="label">Completed</span>
            <span className="value">{completed}</span>
            <span className="small muted">{sessions.length ? `${Math.round((completed / sessions.length) * 100)}% completion` : "—"}</span>
            <div className="timing-bar" style={{ marginTop: 6 }}><div style={{ width: `${sessions.length ? (completed / sessions.length) * 100 : 0}%` }} /></div>
          </div>
        </MotionCard>
      </div>

      <div className="card row">
        <input
          placeholder="Session title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          style={{ flex: 1 }}
        />
        <button className="primary" disabled={creating} onClick={() => void create()}>{creating ? "Creating…" : "Start"}</button>
      </div>

      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}

      {selected.size > 0 && (
        <div className="card row" style={{ justifyContent: "space-between", borderColor: "var(--danger)" }}>
          <span className="small">
            {selected.size} selected
            {sessions.some((s) => selected.has(s.id) && s.status === "live") && (
              <span className="muted"> · live sessions are excluded</span>
            )}
          </span>
          <span className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={() => { setSelected(new Set()); setConfirmBatch(false); }}>Clear</button>
            {confirmBatch ? (
              <>
                <button
                  className="ghost"
                  style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                  disabled={deleting}
                  onClick={() => void deleteSelected()}
                >
                  {deleting ? "Deleting…" : "Delete? This cannot be undone"}
                </button>
                <button className="ghost" onClick={() => setConfirmBatch(false)}>Keep</button>
              </>
            ) : (
              <button className="ghost" style={{ color: "var(--danger)" }} onClick={() => setConfirmBatch(true)}>
                Delete 🗑
              </button>
            )}
          </span>
        </div>
      )}

      {loading ? (
        <div className="col" style={{ gap: 10 }}>
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          description="Name your first session above and press Start — capture, transcription, and coaching are one click away."
        />
      ) : (
        <div className="grid stagger" style={{ gap: 10 }}>
          {sessions.map((s) => {
            const isLive = s.status === "live";
            return (
              <div
                key={s.id}
                className="card hoverable row"
                style={{ justifyContent: "space-between", borderColor: selected.has(s.id) ? "var(--danger)" : undefined }}
                onClick={() => {
                  resetLive(); // clear the previous view; LiveSession hydrates from the API
                  setSession(s.id, s.status);
                  setScreen("live");
                }}
              >
                <div className="row" style={{ gap: 10, flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    disabled={isLive}
                    title={isLive ? "End the live session before deleting it" : "Select for batch delete"}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelect(s.id)}
                    style={{ flex: "none" }}
                  />
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{s.title ?? "Untitled session"}</div>
                    <div className="small muted mono">{s.id.slice(0, 8)}</div>
                  </div>
                </div>
                <div className="row">
                  <StatusPill status={s.status} />
                  <button className="ghost">Open →</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
