import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, PageHeader, Skeleton, Sparkline, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };

export default function Home() {
  const { workspaceId, setSession, setScreen, clearAuth } = useStore();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  async function create() {
    if (!workspaceId) return;
    const s = await api.createSession({ workspaceId, title: title || null, consentStatus: "confirmed" });
    setTitle("");
    setSession(s.id, "draft");
    setScreen("live");
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
            <button className="primary" onClick={() => void create()}>New session</button>
          </>
        }
      />

      <div className="stats">
        <div className="card stat">
          <span className="label">Total</span>
          <span className="value">{sessions.length}</span>
          <Sparkline data={sessions.map((_, i) => sessions.length - i)} />
        </div>
        <div className="card stat">
          <span className="label">Live</span>
          <span className="value">{live}</span>
          <span className="small muted">{live > 0 ? "actively running" : "none active"}</span>
        </div>
        <div className="card stat">
          <span className="label">Completed</span>
          <span className="value">{completed}</span>
          <span className="small muted">{sessions.length ? `${Math.round((completed / sessions.length) * 100)}% completion` : "—"}</span>
        </div>
      </div>

      <div className="card row">
        <input
          placeholder="Session title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          style={{ flex: 1 }}
        />
        <button className="primary" onClick={() => void create()}>Start</button>
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
          {sessions.map((s) => (
            <div
              key={s.id}
              className="card hoverable row"
              style={{ justifyContent: "space-between" }}
              onClick={() => {
                setSession(s.id, s.status);
                setScreen(s.status === "completed" ? "review" : "live");
              }}
            >
              <div className="col" style={{ gap: 2 }}>
                <div style={{ fontWeight: 600 }}>{s.title ?? "Untitled session"}</div>
                <div className="small muted mono">{s.id.slice(0, 8)}</div>
              </div>
              <div className="row">
                <StatusPill status={s.status} />
                <button className="ghost">Open →</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
