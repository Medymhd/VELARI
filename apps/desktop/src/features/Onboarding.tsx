import { useState } from "react";
import { APP_NAME } from "brand";
import { api } from "../lib/api";
import { useStore } from "../state/store";

export default function Onboarding() {
  const { setAuth, setScreen } = useStore();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.auth(email, name || undefined);
      setAuth(res.token, res.user.id, res.workspaceId);
      setScreen("home");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ maxWidth: 460, margin: "8vh auto 0" }}>
      <div className="col" style={{ gap: 6, marginBottom: 20 }}>
        <span className="kicker">Welcome to</span>
        <h1 style={{ fontSize: 28 }}>{APP_NAME}</h1>
        <span className="muted">
          Live interview intelligence — dual-channel transcription, coaching frameworks,
          and post-session review. Your workspace is created automatically on first sign-in.
        </span>
      </div>

      <form onSubmit={submit} className="card col fade-in">
        <label className="col" style={{ gap: 6 }}>
          <span className="small muted">Work email</span>
          <input value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="you@company.com" type="email" required />
        </label>
        <label className="col" style={{ gap: 6 }}>
          <span className="small muted">Display name (optional)</span>
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Alex" />
        </label>
        {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Continue"}
        </button>
        <span className="small muted">
          Local-first: audio is processed per your consent settings. Keys stay in your workspace vault.
        </span>
      </form>
    </div>
  );
}
