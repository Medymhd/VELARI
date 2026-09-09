import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, MotionCard, PageHeader, Skeleton, Sparkline, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };

/** Trash icon — stroke style matching the shell nav icons. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6 M14 11v6" />
    </svg>
  );
}

export default function Home() {
  const { workspaceId, setSession, setScreen, clearAuth, resetLive, notify } = useStore();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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

  /** Warm STT models the instant the user acts on a session — the ~300ms of
   *  screen transition becomes model-load time. Fire-and-forget; failures
   *  are invisible (the WS connect re-warms anyway). */
  function warmOnNavigate() {
    void api.sttWarm();
  }

  /** Delete one session: transcripts, insights, artifacts AND prep materials
   *  cascade server-side; story-bank and answer-cache rows stay (workspace
   *  memory). Live sessions can't be deleted — end them first. */
  async function deleteOne(id: string) {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteSession(id);
      setConfirmDelete(null);
      await refresh();
      notify("success", "Session deleted");
    } catch (ex) {
      notify("error", `Delete failed: ${ex instanceof Error ? ex.message : String(ex)}`);
    } finally {
      setDeleting(false);
    }
  }

  async function create() {
    if (!workspaceId) return;
    setCreating(true);
    warmOnNavigate(); // model load starts during the create round-trip
    try {
      const s = await api.createSession({ workspaceId, title: title || null, consentStatus: "confirmed" });
      setTitle("");
      resetLive(); // a new session starts clean — never inherits the previous one's transcript/insights
      setSession(s.id, "draft", title.trim() || null);
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
            const confirming = confirmDelete === s.id;
            return (
              <div
                key={s.id}
                className="card hoverable row"
                style={{ justifyContent: "space-between", borderColor: confirming ? "var(--danger)" : undefined }}
                onClick={() => {
                  warmOnNavigate();
                  resetLive(); // clear the previous view; LiveSession hydrates from the API
                  setSession(s.id, s.status, s.title ?? null);
                  setScreen("live");
                }}
              >
                <div className="col" style={{ gap: 2 }}>
                  <div style={{ fontWeight: 600 }}>{s.title ?? "Untitled session"}</div>
                  <div className="small muted mono">{s.id.slice(0, 8)}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <StatusPill status={s.status} />
                  <button className="ghost">Open →</button>
                  {confirming ? (
                    <>
                      <button
                        className="ghost"
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        disabled={deleting}
                        onClick={(e) => { e.stopPropagation(); void deleteOne(s.id); }}
                      >
                        {deleting ? "…" : "Delete?"}
                      </button>
                      <button className="ghost" onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}>✕</button>
                    </>
                  ) : (
                    <button
                      className="ghost"
                      style={{ color: "var(--danger)", opacity: 0.75, padding: "6px 8px" }}
                      title={isLive ? "End the live session before deleting it" : "Delete session"}
                      disabled={isLive}
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(s.id); }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
