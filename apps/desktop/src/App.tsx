import type { ReactNode } from "react";
import { APP_NAME } from "brand";
import { useStore } from "./state/store";
import { stealthGetState } from "./lib/tauri";
import { api } from "./lib/api";
import { Keyframes, ToastStack, cn } from "@app/ui";
import Onboarding from "./features/Onboarding";
import Home from "./features/Home";
import LiveSession from "./features/LiveSession";
import Review from "./features/Review";
import Settings from "./features/Settings";
import Research from "./features/Research";
import Work from "./features/Work";
import { useEffect, useState } from "react";

const CORE_NAV = [
  { id: "home", label: "Home", icon: navIcon("M3 10.5 12 3l9 7.5 M5 9.5V21h14V9.5") },
  { id: "live", label: "Live session", icon: navIcon("M2 12h3l2.5-7 4 14 3-10 2 3H22") },
  { id: "review", label: "Review", icon: navIcon("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M21 21l-4.3-4.3") },
] as const;

function navIcon(d: string) {
  const paths = d.split(" M").map((p, i) => (i === 0 ? p : `M${p}`));
  return () => (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

const OVERLAY_DOT: Record<string, string> = { stealth: "var(--accent)", assist: "var(--warn)", none: "var(--muted)" };

function gearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}

interface VerticalInfo {
  id: string;
  displayName: string;
  overlay?: { mode: string };
}

function useVerticals() {
  const [verticals, setVerticals] = useState<VerticalInfo[]>([]);
  useEffect(() => {
    const base = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:8787/v1";
    fetch(`${base}/verticals`)
      .then((r) => (r.ok ? r.json() : { verticals: [] }))
      .then((j: { verticals?: VerticalInfo[] }) => setVerticals(j.verticals ?? []))
      .catch(() => {});
  }, []);
  return verticals;
}

function NavItem(props: { label: string; icon: () => ReactNode; active: boolean; onSelect: () => void; dot?: string }) {
  return (
    <button className={cn("nav-item", props.active && "active")} onClick={props.onSelect}>
      {props.icon()}
      <span>{props.label}</span>
      {props.dot && <span className="nav-dot" title={props.dot} style={{ background: OVERLAY_DOT[props.dot] }} />}
    </button>
  );
}

export default function App() {
  const { screen, setScreen, setStealth, clearAuth, token, notices, dismiss } = useStore();
  const verticals = useVerticals();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => clearAuth();
    window.addEventListener("app:unauthorized", onUnauthorized);
    return () => window.removeEventListener("app:unauthorized", onUnauthorized);
  }, [clearAuth]);

  useEffect(() => {
    stealthGetState().then(setStealth).catch(() => {});
    // A stale token (rotated JWT secret, expired) must land on onboarding, not Home.
    if (token) {
      api.me().then((me) => {
        if (!me.valid) clearAuth();
        setReady(true);
      }).catch(() => { clearAuth(); setReady(true); });
    } else {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (token && screen === "onboarding" && ready) setScreen("home");
  }, [token, screen, ready, setScreen]);

  const activeVertical = verticals.find((v) => v.id === screen);
  const activeLabel =
    screen === "home" || screen === "live" || screen === "review"
      ? verticals.find((v) => v.id === "interview-intelligence")?.displayName ?? "Interview Intelligence"
      : screen === "settings"
        ? "Settings"
        : activeVertical?.displayName ?? APP_NAME;

  useEffect(() => {
    document.title = `${APP_NAME} — ${activeLabel}`;
  }, [activeLabel]);

  if (!ready) return null;

  return (
    <div className="shell">
      <ToastStack notices={notices} onDismiss={dismiss} />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div className="col" style={{ gap: 0 }}>
            <b>{APP_NAME}</b>
            <span className="small muted">{activeLabel}</span>
          </div>
        </div>
        {CORE_NAV.map((item) => (
          <NavItem key={item.id} label={item.label} icon={item.icon} active={screen === item.id} onSelect={() => setScreen(item.id)} />
        ))}
        {verticals.length > 0 && <div className="sidebar-group">Verticals</div>}
        {verticals.map((v) => (
          <NavItem
            key={v.id}
            label={v.displayName}
            icon={navIcon("M4 5h16v14H4z M8 9h8 M8 13h5")}
            active={screen === v.id || (v.id === "interview-intelligence" && ["home", "live", "review"].includes(screen))}
            dot={v.overlay?.mode ?? "none"}
            onSelect={() => setScreen(v.id === "interview-intelligence" ? "home" : v.id)}
          />
        ))}
        <div className="foot">
          <NavItem label="Settings" icon={gearIcon} active={screen === "settings"} onSelect={() => setScreen("settings")} />
          <div className="small muted" style={{ padding: "8px 10px 0" }}>
            v0.1.0 · local-first · BYOK
          </div>
        </div>
      </aside>

      <main className="content">
        <div className="content-inner">
          <Keyframes />
          {screen === "onboarding" && <Onboarding />}
          {screen === "home" && <Home />}
          {screen === "live" && <LiveSession />}
          {screen === "review" && <Review />}
          {screen === "settings" && <Settings />}
          {screen === "research" && <Research />}
          {screen === "work" && <Work />}
          {screen === "settings" && null}
          {activeVertical && !["interview-intelligence", "work", "research"].includes(activeVertical.id) && (
            <div className="card col" style={{ marginTop: 16 }}>
              <span className="kicker">{activeVertical.displayName}</span>
              <span className="small muted">
                Vertical <span className="mono">{screen}</span> mounted at <span className="mono">/v1/verticals/{screen}</span> —
                its dedicated UI lands with the vertical package.
              </span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
