/** @app/ui — shared components. Presentational only; state stays in the apps. */
import type { ReactNode } from "react";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function tokens() {
  return {
    bg: "var(--bg)",
    surface: "var(--surface)",
    border: "var(--border)",
    accent: "var(--accent)",
    radius: "var(--radius)",
  } as const;
}

export function PageHeader(props: {
  kicker?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="page-header">
      <div className="titles">
        {props.kicker && <span className="kicker">{props.kicker}</span>}
        <h2>{props.title}</h2>
        {props.description && <span className="small muted">{props.description}</span>}
      </div>
      {props.actions && <div className="actions">{props.actions}</div>}
    </div>
  );
}

export function Stat(props: { label: string; value: ReactNode; hint?: ReactNode }): ReactNode {
  return (
    <div className="card stat">
      <span className="label">{props.label}</span>
      <span className="value">{props.value}</span>
      {props.hint && <span className="small muted">{props.hint}</span>}
    </div>
  );
}

export function StatusPill(props: { status: string }): ReactNode {
  const tone =
    props.status === "live" ? "accent"
    : props.status === "completed" ? "ok"
    : props.status === "paused" ? "warn"
    : props.status === "failed" ? "danger"
    : "default";
  return <span className={cn("badge", tone)}>{props.status}</span>;
}

export function EmptyState(props: { title: string; description?: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="card subtle col" style={{ alignItems: "center", padding: "32px 20px", textAlign: "center" }}>
      <div
        aria-hidden
        style={{
          width: 44, height: 44, borderRadius: 12, marginBottom: 8,
          background: "var(--accent-grad)", opacity: 0.85,
          boxShadow: "0 6px 24px rgba(108, 123, 255, 0.35)",
        }}
      />
      <div style={{ fontWeight: 600 }}>{props.title}</div>
      {props.description && <span className="small muted" style={{ maxWidth: 380 }}>{props.description}</span>}
      {props.action && <div style={{ marginTop: 10 }}>{props.action}</div>}
    </div>
  );
}

export function Spinner(): ReactNode {
  return (
    <span
      aria-label="loading"
      style={{
        width: 14, height: 14, display: "inline-block", flex: "none",
        border: "2px solid var(--border-strong)", borderTopColor: "var(--accent)",
        borderRadius: "50%", animation: "spin 0.7s linear infinite", verticalAlign: "-2px",
      }}
    />
  );
}

// Injected once per app via <style> — keeps keyframes co-located with usage.
export function Keyframes(): ReactNode {
  return (
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  );
}
