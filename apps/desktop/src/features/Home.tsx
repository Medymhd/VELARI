import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, MotionCard, PageHeader, Skeleton, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };
type TrendEntry = { metrics: { fillerRate: number; wpm: number | null; starShare: number } };

/** Platform dashboard — the landing surface for the whole product, not any
 *  single vertical. Answers "where was I, what's live, what changed" at a
 *  glance, then hands off to the vertical screens. Every cross-vertical
 *  card degrades independently: a dead vertical never blanks the Home. */
export default function Home() {
  const { workspaceId, persona, setSession, setScreen, resetLive, notify } = useStore();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [trend, setTrend] = useState<TrendEntry[] | null>(null);
  const [researchCount, setResearchCount] = useState<number | null>(null);
  const [workOpen, setWorkOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    // Interview Intelligence: recent sessions + aggregate trend.
    api.listSessions(workspaceId)
      .then((list) => setSessions(list as SessionRow[]))
      .catch(() => setSessions(null));
    api.verticalPost<{ trend: TrendEntry[] }>("interview-intelligence", "/arena/analytics", { workspaceId })
      .then((r) => setTrend(r.trend ?? []))
      .catch(() => setTrend(null));
    // Sibling verticals — counts only, each failing silently to "—".
    api.verticalGet<{ chats: unknown[] }>("research", `/chats?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => setResearchCount(Array.isArray(r.chats) ? r.chats.length : 0))
      .catch(() => setResearchCount(null));
    api.verticalGet<{ tasks: Array<{ status?: string }> }>("work", `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => setWorkOpen(Array.isArray(r.tasks) ? r.tasks.filter((t) => t.status !== "done" && t.status !== "completed").length : 0))
      .catch(() => setWorkOpen(null));
  }, [workspaceId]);

  /** Model load starts during navigation — same trick the session screens use. */
  function warmOnNavigate() {
    void api.sttWarm();
  }

  async function newSession() {
    if (!workspaceId || creating) return;
    setCreating(true);
    warmOnNavigate();
    try {
      const s = await api.createSession({ workspaceId, title: null, consentStatus: "confirmed" });
      resetLive();
      setSession(s.id, "draft", null);
      setScreen("live");
    } catch (ex) {
      notify("error", ex instanceof Error ? ex.message : String(ex));
    } finally {
      setCreating(false);
    }
  }

  function openSession(s: SessionRow) {
    warmOnNavigate();
    resetLive(); // LiveSession hydrates fresh from the API
    setSession(s.id, s.status, s.title ?? null);
    setScreen("live");
  }

  if (!workspaceId) {
    return <EmptyState title="No workspace selected" description="Sign in from onboarding to load your dashboard." />;
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const list = sessions ?? [];
  const live = list.find((s) => s.status === "live");
  const draft = list.find((s) => s.status === "draft");
  const lastCompleted = list.find((s) => s.status === "completed");
  const resume = live ?? draft ?? null;

  const trendChips = trend && trend.length > 0 ? [
    { label: "filler", value: `${(trend.reduce((a, t) => a + (t.metrics.fillerRate ?? 0), 0) / trend.length).toFixed(1)}` },
    { label: "wpm", value: trend.some((t) => t.metrics.wpm != null) ? `${Math.round(trend.filter((t) => t.metrics.wpm != null).reduce((a, t) => a + (t.metrics.wpm ?? 0), 0) / trend.filter((t) => t.metrics.wpm != null).length)}` : "—" },
    { label: "star", value: `${Math.round((trend.reduce((a, t) => a + (t.metrics.starShare ?? 0), 0) / trend.length) * 100)}%` },
  ] : null;

  const firstRun = sessions != null && list.length === 0;

  return (
    <div className="col">
      <PageHeader
        kicker="Dashboard"
        title={`${greeting} — ${persona === "interviewer" ? "interviewer mode" : "ready when you are"}`}
        description="Everything across Velari at a glance. Pick up where you left off, or start something new."
      />

      {/* Quick actions */}
      <div className="row stagger" style={{ gap: 10, flexWrap: "wrap" }}>
        <MotionCard delay={0.02}>
          <button className="primary" disabled={creating} onClick={() => void newSession()}>
            {creating ? "Creating…" : "＋ New session"}
          </button>
        </MotionCard>
        <MotionCard delay={0.05}>
          <button className="ghost" onClick={() => setScreen("sessions")}>Sessions</button>
        </MotionCard>
        <MotionCard delay={0.08}>
          <button className="ghost" onClick={() => setScreen("arena")}>Arena drills</button>
        </MotionCard>
        {persona === "interviewer" && (
          <MotionCard delay={0.11}>
            <button className="ghost" onClick={() => setScreen("prep")}>Prep</button>
          </MotionCard>
        )}
      </div>

      {/* Continue where you left off */}
      {resume && (
        <MotionCard delay={0.1}>
          <div
            className="card hoverable row"
            style={{ justifyContent: "space-between", cursor: "pointer", borderColor: "rgba(var(--accent-rgb), 0.35)" }}
            onClick={() => openSession(resume)}
          >
            <div className="col" style={{ gap: 2 }}>
              <span className="kicker">Continue</span>
              <div style={{ fontWeight: 600 }}>{resume.title ?? "Untitled session"}</div>
              <div className="small muted">
                {resume.status === "live" ? "This session is live right now — jump back in." : "Started but not finished. Pick up where you stopped."}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <StatusPill status={resume.status} />
              <button className="ghost">Resume →</button>
            </div>
          </div>
        </MotionCard>
      )}

      {/* Cross-vertical stats — each card independent, failures degrade to "—" */}
      <div className="stats stagger">
        <MotionCard delay={0.06}>
          <div className="stat premium">
            <span className="label">Sessions</span>
            {sessions == null ? <Skeleton height="24px" /> : <span className="value grad">{list.length}</span>}
            <span className="small muted">
              {live ? "1 live now" : `${list.filter((s) => s.status === "completed").length} completed`}
            </span>
          </div>
        </MotionCard>
        <MotionCard delay={0.09}>
          <div className="stat">
            <span className="label">Copilot threads</span>
            <span className="value">{researchCount ?? "—"}</span>
            <span className="small muted">{researchCount == null ? "unavailable" : "research conversations"}</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.12}>
          <div className="stat">
            <span className="label">Work tasks</span>
            <span className="value">{workOpen ?? "—"}</span>
            <span className="small muted">{workOpen == null ? "unavailable" : "open items"}</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.15}>
          <div className="stat">
            <span className="label">Speaking trend</span>
            {trend == null ? (
              <span className="value">—</span>
            ) : trendChips ? (
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                {trendChips.map((c) => (
                  <span key={c.label} className="small mono" style={{ color: "var(--accent)" }}>
                    {c.value} <span className="muted" style={{ color: "var(--muted)" }}>{c.label}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="small muted">no sessions analyzed yet</span>
            )}
          </div>
        </MotionCard>
      </div>

      {/* Interview Intelligence spotlight — recent sessions */}
      <div className="card col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="kicker">Interview intelligence · recent sessions</span>
          <button className="ghost" style={{ padding: "4px 10px" }} onClick={() => setScreen("sessions")}>View all →</button>
        </div>
        {sessions == null ? (
          <div className="col" style={{ gap: 10 }}>
            <Skeleton height="52px" />
            <Skeleton height="52px" />
          </div>
        ) : list.length === 0 ? (
          <span className="small muted">No sessions yet — your first capture starts the trend lines above.</span>
        ) : (
          list.slice(0, 4).map((s) => (
            <div
              key={s.id}
              className="row hoverable"
              style={{ justifyContent: "space-between", padding: "8px 10px", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
              onClick={() => openSession(s)}
            >
              <div style={{ fontWeight: 550 }}>{s.title ?? "Untitled session"}</div>
              <div className="row" style={{ gap: 8 }}>
                <StatusPill status={s.status} />
                <span className="small muted mono">{s.id.slice(0, 8)}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* First-run getting started */}
      {firstRun && (
        <MotionCard delay={0.2}>
          <div className="card col" style={{ gap: 8 }}>
            <span className="kicker">Getting started</span>
            <div className="col" style={{ gap: 6 }}>
              <span className="small"><b>1.</b> Hit <b>New session</b> — capture starts with consent, transcription warms while you talk.</span>
              <span className="small"><b>2.</b> Prep your CV and the job description — every answer grounds itself in your real material.</span>
              <span className="small"><b>3.</b> Review afterwards for fillers, pace and STAR coverage — then drill the weak spots in Arena.</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="primary" disabled={creating} onClick={() => void newSession()}>Start your first session</button>
              <button className="ghost" onClick={() => setScreen("prep")}>Add prep materials</button>
            </div>
          </div>
        </MotionCard>
      )}

      {lastCompleted && !resume && (
        <span className="small muted">
          Last completed: <b>{lastCompleted.title ?? "Untitled session"}</b> — open it from Sessions to review the coaching insights.
        </span>
      )}
    </div>
  );
}
