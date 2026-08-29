import type { ReactNode } from "react";
import { APP_NAME } from "brand";
import { useStore } from "./state/store";
import { stealthGetState } from "./lib/tauri";
import { Keyframes, cn, CommandPalette } from "@app/ui";
import Onboarding from "./features/Onboarding";
import Home from "./features/Home";
import LiveSession from "./features/LiveSession";
import Review from "./features/Review";
import Settings from "./features/Settings";
import { useEffect, useState } from "react";

const CORE_NAV = [
  { id: "home", label: "Home", icon: homeIcon },
  { id: "live", label: "Live session", icon: liveIcon },
  { id: "review", label: "Review", icon: reviewIcon },
  { id: "settings", label: "Settings", icon: settingsIcon },
] as const;

// Verticals are not hard-coded — shell fetches `/v1/verticals` (server.ts discoverVerticals) and
// renders whatever manifests the API discovered from `verticals/*` packages. Adding a new vertical
// alongside the 2 built (interview-intelligence, work-assistant) only requires a new `verticals/<id>`
// package; this shell never needs an edit.
function useVerticals() {
  const [verticals, setVerticals] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    const base = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:8787/v1";
    fetch(`${base}/verticals`)
      .then((r) => (r.ok ? r.json() : { verticals: [] }))
      .then((j: { verticals?: { id: string; displayName: string }[] }) => setVerticals(j.verticals ?? []))
      .catch(() => {});
  }, []);
  return verticals;
}

const NAV = CORE_NAV;

function homeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}
function liveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2 12h3l2.5-7 4 14 3-10 2 3H22" />
    </svg>
  );
}
function reviewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function settingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}

function NavItem(props: { id: string; label: string; icon: () => ReactNode; active: boolean; onSelect: () => void }) {
  return (
    <button className={cn("nav-item", props.active && "active")} onClick={props.onSelect}>
      {props.icon()}
      <span>{props.label}</span>
    </button>
  );
}

function workIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 8h10M7 12h10M7 16h6" />
    </svg>
  );
}

export default function App() {
  const { screen, setScreen, setStealth, token } = useStore();
  const verticals = useVerticals();
  const [ready, setReady] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const paletteActions = [
    ...(["home", "live", "review", "settings"] as const).map((s) => ({
      label: `Go to ${s.charAt(0).toUpperCase() + s.slice(1)}`,
      run: () => setScreen(s),
    })),
  ];

  useEffect(() => {
    document.title = `${APP_NAME} — Interview Intelligence`;
    stealthGetState().then(setStealth).catch(() => {});
    setReady(true);
  }, [setStealth]);

  useEffect(() => {
    if (token && screen === "onboarding") setScreen("home");
  }, [token, screen, setScreen]);

  if (!ready) return null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div className="col" style={{ gap: 0 }}>
            <b>{APP_NAME}</b>
            <span className="small muted">Interview Intelligence</span>
          </div>
        </div>
        {NAV.map((item) => (
          <NavItem
            key={item.id}
            id={item.id}
            label={item.label}
            icon={item.icon}
            active={screen === item.id}
            onSelect={() => setScreen(item.id)}
          />
        ))}
        {verticals.length > 0 && <div className="divider" />}
        {verticals
          .filter((v) => v.id !== "interview-intelligence")
          .map((v) => (
            <NavItem
              key={v.id}
              id={v.id}
              label={v.displayName}
              icon={workIcon}
              active={screen === v.id}
              onSelect={() => setScreen(v.id)}
            />
          ))}
        <div className="foot small muted">
          <div>v0.1.0 · local-first</div>
          <div>BYOK · consent-driven</div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {verticals.length} verticals · add via <span className="mono">verticals/*</span>
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
          {verticals.some((v) => v.id === screen) && (
            <div className="card col" style={{ marginTop: 16 }}>
              <span className="kicker">{verticals.find((v) => v.id === screen)?.displayName}</span>
              <h3 style={{ margin: 0 }}>{verticals.find((v) => v.id === screen)?.displayName}</h3>
              <span className="small muted">
                Vertical <span className="mono">{screen}</span> mounted via <span className="mono">/v1/verticals/{screen}</span> — no hard-coded NAV. Add a new <span className="mono">verticals/&lt;id&gt;</span> package and it appears here without editing <span className="mono">App.tsx</span> or <span className="mono">server.ts</span>.
              </span>
            </div>
          )}
        </div>
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions(setScreen)}
      />
    </div>
  );
}
