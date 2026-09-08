import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { Skeleton, Sparkline } from "@app/ui";

interface SessionMetrics {
  wordCount: number;
  fillerRate: number;
  wpm: number | null;
  verbosity: number;
  starShare: number;
  segmentCount: number;
}

interface Verdicts {
  filler: "good" | "ok" | "warn";
  pace: "good" | "ok" | "warn" | null;
  star: "good" | "ok" | "warn";
}

interface TrendEntry {
  sessionId: string;
  title: string | null;
  startedAt: string | null;
  metrics: SessionMetrics;
  verdicts: Verdicts;
}

type Verdict = "good" | "ok" | "warn";

/** Speech analytics strip — fillers, pace, STAR share with verdict arrows and
 *  cross-session sparklines, straight from POST /arena/analytics (no client math). */
export default function SessionMetricsPanel() {
  const { workspaceId, sessionId } = useStore();
  const [trend, setTrend] = useState<TrendEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setTrend(null);
    api
      .verticalPost<{ trend: TrendEntry[] }>("interview-intelligence", "/arena/analytics", { workspaceId })
      .then((res) => {
        if (!alive) return;
        setTrend(Array.isArray(res.trend) ? res.trend : []);
        setErr(null);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  if (!workspaceId) return null;

  const current = trend?.find((t) => t.sessionId === sessionId) ?? null;

  return (
    <div className="card col" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="kicker">Speech analytics{current ? " — this session" : ""}</span>
        {trend && trend.length > 0 && (
          <span className="small muted">
            trend across last {trend.length} session{trend.length > 1 ? "s" : ""} · oldest → newest
          </span>
        )}
      </div>

      {trend === null && !err && <Skeleton height="72px" />}

      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}

      {trend !== null && current && (
        <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
          <MetricChip
            label="Fillers / 100 words"
            value={String(current.metrics.fillerRate)}
            verdict={current.verdicts.filler}
            trend={trend.map((t) => t.metrics.fillerRate)}
          />
          <MetricChip
            label="Pace"
            value={current.metrics.wpm == null ? "untimed" : `${current.metrics.wpm} wpm`}
            verdict={current.verdicts.pace}
            trend={trend.map((t) => t.metrics.wpm).filter((w): w is number => w != null)}
          />
          <MetricChip
            label="STAR-structured"
            value={`${Math.round(current.metrics.starShare * 100)}%`}
            verdict={current.verdicts.star}
            trend={trend.map((t) => Math.round(t.metrics.starShare * 100))}
          />
          <MetricChip
            label="Words / answer"
            value={String(current.metrics.verbosity)}
            verdict={null}
            trend={trend.map((t) => t.metrics.verbosity)}
          />
        </div>
      )}

      {trend !== null && !current && !err && (
        <span className="small muted">
          No metrics yet for this session — analytics land once its transcript has spoken segments.
        </span>
      )}
    </div>
  );
}

function MetricChip(props: { label: string; value: string; verdict: Verdict | null; trend: number[] }) {
  return (
    <div className="col" style={{ gap: 4, flex: 1, minWidth: 128 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
        <span className="small muted">{props.label}</span>
        {props.verdict && <VerdictArrow verdict={props.verdict} />}
      </div>
      <span style={{ fontWeight: 600, fontSize: 17 }}>{props.value}</span>
      {props.trend.length > 1 && <Sparkline data={props.trend} width={120} height={22} />}
    </div>
  );
}

/** Trend arrow from the backend verdict — colored, with the raw word as tooltip. */
function VerdictArrow(props: { verdict: Verdict }) {
  const style =
    props.verdict === "good"
      ? { color: "var(--success)" }
      : props.verdict === "warn"
        ? { color: "var(--danger)" }
        : { color: "var(--warn)" };
  return (
    <span className="badge" style={style} title={props.verdict}>
      {props.verdict === "good" ? "▲" : props.verdict === "warn" ? "▼" : "▬"}
    </span>
  );
}
