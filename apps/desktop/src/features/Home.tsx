import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, MotionCard, Skeleton, Sparkline, StatusPill } from "@app/ui";

type SessionRow = { id: string; title: string | null; status: string };
type TrendEntry = { metrics: { fillerRate: number; wpm: number | null; starShare: number } };

function icon(paths: string, width = 20) {
  const d = paths.split(" M").map((p, i) => (i === 0 ? p : `M${p}`));
  return () => (
    <svg viewBox="0 0 24 24" width={width} height={width} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

const MicIcon = icon("M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3");
const ListIcon = icon("M4 5h16v14H4z M8 9h8 M8 13h5");
const ArenaIcon = icon("M6 4v16 M18 4l-6 8 6 8 M4 6h5 M4 12h5 M4 18h5");
const ChartIcon = icon("M3 20h18 M6 16v-5 M11 16V7 M16 16v-8");
const BoltIcon = icon("M13 2 4 14h6l-1 8 9-12h-6l1-8z");
const ClockIcon = icon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2");
const DocIcon = icon("M6 2h8l4 4v16H6z M14 2v4h4 M9 12h6 M9 16h6");

/** Animated count-up for metric values. Respects reduced-motion; formats via the caller. */
function useCountUp(target: number | null, duration = 900): number | null {
  const [val, setVal] = useState<number | null>(0);
  useEffect(() => {
    if (target == null || !Number.isFinite(target)) { setVal(null); return; }
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setVal(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setVal(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function initials(title: string | null): string {
  if (!title) return "•";
  const words = title.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "•";
}

function MetricValue({ value, format }: { value: number | null; format: (v: number) => string }) {
  const animated = useCountUp(value);
  if (value == null || animated == null) return <span className="metric-value muted">—</span>;
  return <span className="metric-value">{format(animated)}</span>;
}

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

  function openReview(s: SessionRow) {
    warmOnNavigate();
    resetLive();
    setSession(s.id, s.status, s.title ?? null);
    setScreen("review");
  }

  if (!workspaceId) {
    return <EmptyState title="No workspace selected" description="Sign in from onboarding to load your dashboard." />;
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const list = sessions ?? [];
  const live = list.find((s) => s.status === "live");
  const draft = list.find((s) => s.status === "draft");
  const resume = live ?? draft ?? null;
  const lastCompleted = list.find((s) => s.status === "completed");

  const analyzed = trend ?? [];
  const avg = (pick: (t: TrendEntry) => number | null) => {
    const vals = analyzed.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  const completed = list.filter((s) => s.status === "completed").length;
  const completion = list.length ? completed / list.length : null;
  const stats = {
    sessions: list.length,
    filler: avg((t) => t.metrics.fillerRate),
    wpm: avg((t) => t.metrics.wpm),
    star: avg((t) => t.metrics.starShare),
  };
  const fillerSeries = analyzed.map((t) => t.metrics.fillerRate);
  const wpmSeries = analyzed.map((t) => t.metrics.wpm).filter((v): v is number => v != null);
  const starSeries = analyzed.map((t) => t.metrics.starShare * 100);

  // Smartest next action, derived from real state — no new endpoints.
  const weakest: { label: string; detail: string } | null =
    analyzed.length > 0 && stats.filler != null && stats.filler > 0.08
      ? { label: "Cut the fillers", detail: `${stats.filler.toFixed(1)} fillers/min — drill clean delivery` }
      : analyzed.length > 0 && stats.star != null && stats.star < 0.6
        ? { label: "Structure your answers", detail: `${Math.round(stats.star * 100)}% STAR coverage — drill STAR framing` }
        : analyzed.length > 0 && stats.wpm != null && (stats.wpm < 110 || stats.wpm > 180)
          ? { label: "Steady your pace", detail: `${Math.round(stats.wpm)} wpm — drill calm pacing` }
          : null;
  const nextStep = list.length === 0
    ? { icon: DocIcon, kicker: "First run", title: "Add your prep materials", desc: "Drop in a CV and a job description — every answer grounds itself in them.", cta: "Open Prep", onClick: () => setScreen("prep") }
    : resume
      ? {
          icon: ClockIcon,
          kicker: "Continue",
          title: live ? "Jump back into your live session" : `Resume “${(resume.title ?? "Untitled").slice(0, 30)}”`,
          desc: live ? "Capture is running — coaching is one click away." : "Picked up right where you left off.",
          cta: "Resume →",
          onClick: () => openSession(resume),
        }
      : weakest
        ? { icon: BoltIcon, kicker: "Recommended drill", title: weakest.label, desc: weakest.detail, cta: "Train in Arena →", onClick: () => setScreen("arena") }
        : lastCompleted
          ? { icon: ChartIcon, kicker: "Review", title: `Review “${(lastCompleted.title ?? "Untitled").slice(0, 30)}”`, desc: "Fillers, pace and STAR coverage, scored.", cta: "Open review →", onClick: () => openReview(lastCompleted) }
          : { icon: ListIcon, kicker: "Sessions", title: "Browse your sessions", desc: "Every conversation, transcript and insight in one place.", cta: "Open →", onClick: () => setScreen("sessions") };

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
  const NextIcon = nextStep.icon;

  return (
    <div className="col dash">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="hero" aria-label="Dashboard overview">
        <div className="hero-mesh" aria-hidden />
        <div className="hero-copy">
          <span className="hero-eyebrow">
            {live ? <><span className="dot pulse" /> Live now</> : <>{today} · {persona === "interviewer" ? "Interviewer mode" : "Candidate mode"}</>}
          </span>
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
          <button className="hero-live" onClick={() => openSession(live)} aria-label={`Return to live session ${live.title ?? "untitled"}`}>
            <div className="row" style={{ gap: 8 }}>
              <span className="dot pulse" />
              <b>Live now</b>
            </div>
            <div className="hero-live-title">{live.title ?? "Untitled session"}</div>
            <span className="small muted">Recording · coaching active · click to return</span>
          </button>
        )}
      </section>

      {/* ── Metrics band ─────────────────────────────────────────────── */}
      <div className="metrics-band stagger" role="region" aria-label="Performance metrics">
        <MotionCard delay={0.03}>
          <div className="metric">
            <div className="metric-head">
              <span className="metric-icon accent"><ListIcon /></span>
              <span className="metric-label">Sessions</span>
            </div>
            {sessions == null ? <Skeleton height="30px" /> : <MetricValue value={stats.sessions} format={(v) => `${Math.round(v)}`} />}
            {sessions == null ? null : completion == null ? (
              <span className="metric-sub">No sessions yet</span>
            ) : (
              <>
                <div className="meter" role="progressbar" aria-valuenow={Math.round(completion * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Session completion rate">
                  <div className="meter-fill" style={{ width: `${Math.round(completion * 100)}%` }} />
                </div>
                <span className="metric-sub">{completed} of {stats.sessions} completed</span>
              </>
            )}
          </div>
        </MotionCard>
        <MotionCard delay={0.06}>
          <div className="metric">
            <div className="metric-head">
              <span className="metric-icon"><MicIcon /></span>
              <span className="metric-label">Fillers / min</span>
            </div>
            {stats.filler == null ? <span className="metric-value muted">—</span> : <MetricValue value={stats.filler} format={(v) => v.toFixed(1)} />}
            {fillerSeries.length > 1 ? <Sparkline data={fillerSeries} /> : <span className="metric-sub">{analyzed.length ? "1 session analyzed" : "No sessions analyzed yet"}</span>}
          </div>
        </MotionCard>
        <MotionCard delay={0.09}>
          <div className="metric">
            <div className="metric-head">
              <span className="metric-icon"><BoltIcon /></span>
              <span className="metric-label">Words / min</span>
            </div>
            {stats.wpm == null ? <span className="metric-value muted">—</span> : <MetricValue value={stats.wpm} format={(v) => `${Math.round(v)}`} />}
            {wpmSeries.length > 1 ? <Sparkline data={wpmSeries} /> : <span className="metric-sub">{stats.wpm == null ? "Pace appears after review" : "1 session analyzed"}</span>}
          </div>
        </MotionCard>
        <MotionCard delay={0.12}>
          <div className="metric">
            <div className="metric-head">
              <span className="metric-icon"><ChartIcon /></span>
              <span className="metric-label">STAR coverage</span>
            </div>
            {stats.star == null ? <span className="metric-value muted">—</span> : <MetricValue value={stats.star * 100} format={(v) => `${Math.round(v)}%`} />}
            {starSeries.length > 1 ? <Sparkline data={starSeries} /> : <span className="metric-sub">{stats.star == null ? "Drill in Arena to improve" : "1 session analyzed"}</span>}
          </div>
        </MotionCard>
        <MotionCard delay={0.15}>
          <div className="metric">
            <div className="metric-head">
              <span className="metric-icon"><ArenaIcon /></span>
              <span className="metric-label">Copilot threads</span>
            </div>
            {researchCount == null ? <span className="metric-value muted">—</span> : <MetricValue value={researchCount} format={(v) => `${Math.round(v)}`} />}
            <span className="metric-sub">{workOpen == null ? "Workspace activity" : `${workOpen} open work task${workOpen === 1 ? "" : "s"}`}</span>
          </div>
        </MotionCard>
      </div>

      {/* ── Sessions + next step ─────────────────────────────────────── */}
      <div className="dash-grid">
        <section className="card spotlight" aria-label="Recent sessions">
          <div className="section-head">
            <span className="kicker">Interview intelligence · recent sessions</span>
            <button className="ghost" style={{ padding: "4px 10px" }} onClick={() => setScreen("sessions")}>View all →</button>
          </div>
          {sessions == null ? (
            <div className="col" style={{ gap: 10 }}>
              <Skeleton height="56px" />
              <Skeleton height="56px" />
              <Skeleton height="56px" />
            </div>
          ) : list.length === 0 ? (
            <span className="small muted">No sessions yet — your first capture starts the trend lines above.</span>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {list.slice(0, 5).map((s) => (
                <button
                  key={s.id}
                  className="session-row"
                  onClick={() => openSession(s)}
                  aria-label={`Open session ${s.title ?? "untitled"}`}
                >
                  <span className="avatar" aria-hidden>{initials(s.title)}</span>
                  <span className="session-meta">
                    <span className="session-title">{s.title ?? "Untitled session"}</span>
                    <span className="small muted mono">{s.id.slice(0, 8)}</span>
                  </span>
                  <StatusPill status={s.status} />
                  <span className="session-chevron" aria-hidden>→</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="col" style={{ gap: 12 }}>
          <div className="card col nextstep fade-in" style={{ animationDelay: "0.1s" }}>
            <div className="nextstep-head">
              <span className="tile-icon accent"><NextIcon /></span>
              <span className="kicker">{nextStep.kicker}</span>
            </div>
            <div className="nextstep-title">{nextStep.title}</div>
            <div className="small muted">{nextStep.desc}</div>
            <button className="primary nextstep-cta" onClick={nextStep.onClick}>{nextStep.cta}</button>
          </div>
        </div>
      </div>

      {/* ── Feature tiles ────────────────────────────────────────────── */}
      <div className="tile-grid stagger">
        {tiles.map((t, i) => (
          <MotionCard key={t.key} delay={0.04 * i}>
            <button className="tile" onClick={t.onClick} disabled={t.key === "new" && creating} aria-label={t.title}>
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

      {/* ── First-run getting started ────────────────────────────────── */}
      {firstRun && (
        <section className="card onboard" aria-label="Getting started">
          <span className="kicker">Getting started</span>
          <ol className="steps">
            <li>
              <span className="step-node">1</span>
              <div>
                <b>Start your first live session</b>
                <p>Capture starts with consent — transcription warms while you talk.</p>
              </div>
            </li>
            <li>
              <span className="step-node">2</span>
              <div>
                <b>Add your CV and the job description</b>
                <p>Every coached answer grounds itself in your real material.</p>
              </div>
            </li>
            <li>
              <span className="step-node">3</span>
              <div>
                <b>Review, then drill the weak spots</b>
                <p>Fillers, pace and STAR coverage — then Arena practice.</p>
              </div>
            </li>
          </ol>
        </section>
      )}
    </div>
  );
}
