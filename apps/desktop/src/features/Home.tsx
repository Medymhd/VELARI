import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, MotionCard, Skeleton, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };
type TrendEntry = { metrics: { fillerRate: number; wpm: number | null; starShare: number } };

function icon(paths: string) {
  const d = paths.split(" M").map((p, i) => (i === 0 ? p : `M${p}`));
  return () => (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

const MicIcon = icon("M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3");
const ListIcon = icon("M4 5h16v14H4z M8 9h8 M8 13h5");
const ArenaIcon = icon("M6 4v16 M18 4l-6 8 6 8 M4 6h5 M4 12h5 M4 18h5");
const ChartIcon = icon("M3 20h18 M6 16v-5 M11 16V7 M16 16v-8");

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
  const resume = live ?? draft ?? null;

  const analyzed = trend ?? [];
  const avg = (pick: (t: TrendEntry) => number | null) => {
    const vals = analyzed.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  const stats = {
    sessions: list.length,
    completed: list.filter((s) => s.status === "completed").length,
    filler: avg((t) => t.metrics.fillerRate),
    wpm: avg((t) => t.metrics.wpm),
    star: avg((t) => t.metrics.starShare),
  };

  const tiles = [
    {
      key: "new",
      icon: MicIcon,
      title: "Start a live session",
      desc: "Capture both sides of the conversation with real-time coaching",
      cta: creating ? "Creating…" : "Go live",
      primary: true,
      onClick: () => void newSession(),
    },
    {
      key: "sessions",
      icon: ListIcon,
      title: "Browse sessions",
      desc: "Every conversation, transcript and insight in one place",
      cta: "Open",
      onClick: () => setScreen("sessions"),
    },
    {
      key: "arena",
      icon: ArenaIcon,
      title: "Train in the Arena",
      desc: "Drill predicted questions and sharpen your delivery",
      cta: "Practice",
      onClick: () => setScreen("arena"),
    },
    {
      key: "review",
      icon: ChartIcon,
      title: "Review performance",
      desc: "Fillers, pace and STAR coverage scored across sessions",
      cta: "Analyze",
      onClick: () => setScreen("review"),
    },
  ];

  const firstRun = sessions != null && list.length === 0;

  return (
    <div className="col dash">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-copy">
          <span className="hero-kicker">{persona === "interviewer" ? "Interviewer mode" : "Candidate mode"}</span>
          <h1 className="hero-title">
            {greeting}. <span className="grad-text">Your interview edge</span> starts here.
          </h1>
          <p className="hero-sub">
            {firstRun
              ? "Capture your first conversation and Velari turns it into grounded answers, scored delivery and a personal question bank."
              : "Pick up a live session, drill the weak spots, or review what the last conversation taught you."}
          </p>
          <div className="hero-actions">
            <button className="primary hero-cta" disabled={creating} onClick={() => void newSession()}>
              {creating ? "Creating…" : live ? "Return to live session" : "New live session"}
            </button>
            {resume && live == null && (
              <button className="hero-cta secondary-cta" onClick={() => openSession(resume)}>
                Resume “{(resume.title ?? "Untitled").slice(0, 28)}”
              </button>
            )}
            <button className="hero-cta secondary-cta" onClick={() => setScreen("prep")}>
              Prep materials
            </button>
          </div>
        </div>
        {/* Live pulse card — only when something is actually running */}
        {live && (
          <div className="hero-live" onClick={() => openSession(live)} role="button" tabIndex={0}>
            <div className="row" style={{ gap: 8 }}>
              <span className="dot" />
              <b>Live now</b>
            </div>
            <div style={{ fontWeight: 600 }}>{live.title ?? "Untitled session"}</div>
            <span className="small muted">Recording · coaching active · click to return</span>
          </div>
        )}
      </section>

      {/* ── Feature tiles ────────────────────────────────────────────── */}
      <div className="tile-grid stagger">
        {tiles.map((t, i) => (
          <MotionCard key={t.key} delay={0.04 * i}>
            <button className="tile" onClick={t.onClick} disabled={t.key === "new" && creating}>
              <span className={t.primary ? "tile-icon accent" : "tile-icon"}><t.icon /></span>
              <span className="tile-body">
                <span className="tile-title">{t.title}</span>
                <span className="tile-desc">{t.desc}</span>
              </span>
              <span className={`tile-cta ${t.primary ? "accent" : ""}`}>{t.cta} →</span>
            </button>
          </MotionCard>
        ))}
      </div>

      {/* ── Metrics band ─────────────────────────────────────────────── */}
      <div className="metrics-band stagger">
        <MotionCard delay={0.05}>
          <div className="metric">
            <span className="metric-value grad-text">{sessions == null ? "—" : stats.sessions}</span>
            <span className="metric-label">Sessions</span>
            <span className="metric-sub">{stats.completed} completed</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.1}>
          <div className="metric">
            <span className="metric-value">{stats.filler == null ? "—" : stats.filler.toFixed(1)}</span>
            <span className="metric-label">Fillers / min</span>
            <span className="metric-sub">{analyzed.length ? "across analyzed sessions" : "no sessions analyzed yet"}</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.15}>
          <div className="metric">
            <span className="metric-value">{stats.wpm == null ? "—" : Math.round(stats.wpm)}</span>
            <span className="metric-label">Words / min</span>
            <span className="metric-sub">{stats.wpm == null ? "pace appears after review" : "speaking pace"}</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.2}>
          <div className="metric">
            <span className="metric-value">{stats.star == null ? "—" : `${Math.round(stats.star * 100)}%`}</span>
            <span className="metric-label">STAR coverage</span>
            <span className="metric-sub">{stats.star == null ? "drill in Arena to improve" : "structured answers"}</span>
          </div>
        </MotionCard>
        <MotionCard delay={0.25}>
          <div className="metric">
            <span className="metric-value">{researchCount ?? "—"}</span>
            <span className="metric-label">Copilot threads</span>
            <span className="metric-sub">{workOpen == null ? "unavailable" : `${workOpen} open work tasks`}</span>
          </div>
        </MotionCard>
      </div>

      {/* ── Spotlight: recent sessions ───────────────────────────────── */}
      <div className="card col" style={{ gap: 8 }}>
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
              className="row hoverable dash-row"
              style={{ justifyContent: "space-between" }}
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

      {/* ── First-run getting started ────────────────────────────────── */}
      {firstRun && (
        <MotionCard delay={0.25}>
          <div className="card col onboard-card" style={{ gap: 10 }}>
            <span className="kicker">Getting started</span>
            <div className="col" style={{ gap: 6 }}>
              <span className="small"><b>1.</b> Hit <b>New live session</b> — capture starts with consent, transcription warms while you talk.</span>
              <span className="small"><b>2.</b> Add your CV and the job description — every coached answer grounds itself in your real material.</span>
              <span className="small"><b>3.</b> Review afterwards for fillers, pace and STAR coverage — then drill the weak spots in Arena.</span>
            </div>
          </div>
        </MotionCard>
      )}
    </div>
  );
}
