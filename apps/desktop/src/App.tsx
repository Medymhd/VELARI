import type { ReactNode } from "react";
import { APP_NAME } from "brand";
import { useStore } from "./state/store";
import { stealthGetState } from "./lib/tauri";
import { Keyframes, cn } from "@app/ui";
import Onboarding from "./features/Onboarding";
import Home from "./features/Home";
import LiveSession from "./features/LiveSession";
import Review from "./features/Review";
import Settings from "./features/Settings";
import { useEffect, useState } from "react";

const NAV = [
  { id: "home", label: "Home", icon: homeIcon },
  { id: "live", label: "Live session", icon: liveIcon },
  { id: "review", label: "Review", icon: reviewIcon },
  { id: "settings", label: "Settings", icon: settingsIcon },
] as const;

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

export default function App() {
  const { screen, setScreen, setStealth, token } = useStore();
  const [ready, setReady] = useState(false);

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
        <div className="foot small muted">
          <div>v0.1.0 · local-first</div>
          <div>BYOK · consent-driven</div>
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
        </div>
      </main>
    </div>
  );
}
