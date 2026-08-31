/** @app/ui — shared components. Presentational only; state stays in the apps. */
import { useEffect, useState } from "react";
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

// Premium primitives — @app/ui single source, no per-vertical duplication (Phase A)
// Used by interview, work, research, code, sheet — spring motion + skeleton replace Spinner-only
export function Skeleton(props: { width?: string; height?: string; radius?: string }): ReactNode {
  return <div className="skeleton" style={{ width: props.width ?? "100%", height: props.height ?? "14px", borderRadius: props.radius ?? "var(--radius-sm)" }} />;
}

export function MotionCard(props: { children: ReactNode; delay?: number }): ReactNode {
  return (
    <div className="card fade-in" style={{ animationDelay: `${props.delay ?? 0}s` }}>
      {props.children}
    </div>
  );
}

export function Section(props: { kicker?: string; title?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="card col">
      {(props.kicker || props.title) && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            {props.kicker && <span className="kicker">{props.kicker}</span>}
            {props.title && <h3 style={{ margin: "4px 0 0" }}>{props.title}</h3>}
          </div>
          {props.actions}
        </div>
      )}
      {props.children}
    </div>
  );
}

/** Pure SVG sparkline — takes numeric data points, renders accent-gradient polyline. */
export function Sparkline(props: { data: number[]; width?: number; height?: number }): ReactNode {
  const w = props.width ?? 120;
  const h = props.height ?? 32;
  const data = props.data;
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(" ");
  const gradId = `spark-${Math.abs(data[0]! * 1000).toFixed(0)}`;
  return (
    <svg width={w} height={h} style={{ display: "block" }} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.6" />
          <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <polyline points={pts} fill="none" stroke={`url(#${gradId})`} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - ((data[data.length - 1]! - min) / range) * (h - 4) - 2} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

/** Toggle switch — styled checkbox that reads as a premium toggle.
 *  Uses the natural 44×26 switch CSS in styles.css; no inline size overrides
 *  (off-spec sizes break the knob geometry). */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className="row" style={{ cursor: props.disabled ? "default" : "pointer", gap: 10 }}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label && <span className="small">{props.label}</span>}
    </label>
  );
}

/** Toast stack — fixed top-right; auto-dismisses. Render once in the app shell. */
export function ToastStack(props: { notices: { id: string; kind: "info" | "success" | "error"; message: string }[]; onDismiss: (id: string) => void }): ReactNode {
  useEffect(() => {
    if (props.notices.length === 0) return;
    const timers = props.notices.map((n) => setTimeout(() => props.onDismiss(n.id), n.kind === "error" ? 6000 : 3200));
    return () => timers.forEach(clearTimeout);
  }, [props.notices, props.onDismiss]);
  if (props.notices.length === 0) return null;
  return (
    <div style={{ position: "fixed", top: 14, right: 14, zIndex: "var(--z-toast, 60)", display: "flex", flexDirection: "column", gap: 8, maxWidth: 380 }}>
      {props.notices.map((n) => (
        <div
          key={n.id}
          className="fade-in"
          role="status"
          onClick={() => props.onDismiss(n.id)}
          style={{
            padding: "10px 14px", borderRadius: "var(--radius)", cursor: "pointer",
            background: "var(--surface-elev, var(--surface))",
            border: `1px solid ${n.kind === "error" ? "var(--danger)" : n.kind === "success" ? "var(--success)" : "var(--border-strong)"}`,
            borderLeftWidth: 3,
            boxShadow: "var(--shadow-2)",
            fontSize: 13, lineHeight: 1.45,
          }}
        >
          {n.message}
        </div>
      ))}
    </div>
  );
}

/** Command palette — Ctrl+K modal with filtered actions. */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  actions: { label: string; hint?: string; run: () => void }[];
}): ReactNode {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (props.open) { setQuery(""); setSel(0); }
  }, [props.open]);
  if (!props.open) return null;

  const filtered = props.actions.filter(
    (a) => a.label.toLowerCase().includes(query.toLowerCase())
  );
  const commit = (i: number) => { props.onClose(); filtered[i]?.run(); };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-modal, 50)", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}
      onMouseDown={() => props.onClose()}>
      <div style={{ width: 480, maxWidth: "90vw", borderRadius: "var(--radius)", background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-3)", overflow: "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus placeholder="Type a command…" value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && filtered[sel]) { props.onClose(); filtered[sel]!.run(); }
            if (e.key === "Escape") props.onClose();
          }}
          style={{ width: "100%", padding: "14px 16px", border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, fontSize: 15, background: "var(--bg-elev)" }}
        />
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {filtered.length === 0 && <div className="small muted" style={{ padding: "12px 16px" }}>No matches.</div>}
          {filtered.map((a, i) => (
            <div key={a.label}
              style={{ padding: "10px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
                background: i === sel ? "var(--surface-3)" : "transparent" }}
              onMouseEnter={() => setSel(i)}
              onClick={() => { props.onClose(); a.run(); }}>
              <span style={{ fontSize: 13 }}>{a.label}</span>
              {a.hint && <kbd className="small muted">{a.hint}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
