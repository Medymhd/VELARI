import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { stealthEnforceNow, stealthGetState } from "../lib/tauri";
import { PageHeader, Section, Skeleton, Toggle } from "@app/ui";

interface ProviderRow { id: string; provider: string; hasSecret: boolean }
interface ProfileRow {
  id: string;
  name: string;
  taskClass: string;
  primaryModel: unknown;
  fallbackModels: unknown[];
  enabled?: boolean;
}

const PROVIDERS = ["openai", "anthropic", "groq", "deepseek", "bai", "deepgram"] as const;
const PRIVACY_MODES = ["local_only", "byok_only", "managed_allowed"] as const;

export default function Settings() {
  const { workspaceId, stealth, setStealth } = useStore();
  const [provider, setProvider] = useState<string>("groq");
  const [secret, setSecret] = useState("");
  const [connections, setConnections] = useState<ProviderRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [editing, setEditing] = useState<Record<string, { primary: string; fallbacks: string }>>({});
  const [privacyMode, setPrivacyMode] = useState<string>("managed_allowed");
  const [stealthAllowed, setStealthAllowed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!workspaceId) return;
    setLoading(true);
    setErr(null);
    try {
      setConnections(await api.providerConnections(workspaceId));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    try {
      setProfiles(await api.modelProfiles(workspaceId));
    } catch { /* no profiles yet */ }
    try {
      const policy = (await api.policy(workspaceId)) as { privacyMode?: string; stealthAllowed?: boolean };
      if (policy.privacyMode) setPrivacyMode(policy.privacyMode);
      setStealthAllowed(policy.stealthAllowed === true);
    } catch { /* default policy */ }
    const s = await stealthGetState().catch(() => null);
    if (s) setStealth(s);
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, [workspaceId]);

  function flash(m: string) { setMsg(m); setErr(null); }
  function fail(e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setMsg(null); }

  async function connect() {
    if (!workspaceId || !secret) return;
    try {
      await api.connectProvider({ workspaceId, provider, secret });
      setSecret("");
      flash(`Connected ${provider} — key sealed into the vault`);
      void refresh();
    } catch (e) { fail(e); }
  }

  async function disconnect(id: string, name: string) {
    try {
      await api.deleteProvider(id);
      flash(`Disconnected ${name}`);
      void refresh();
    } catch (e) { fail(e); }
  }

  async function saveProfile(p: ProfileRow) {
    const draft = editing[p.id];
    if (!draft) return;
    try {
      const primaryModel = JSON.parse(draft.primary) as Record<string, unknown>;
      const fallbackModels = JSON.parse(draft.fallbacks || "[]") as unknown[];
      await api.updateModelProfile(p.id, { name: p.name, taskClass: p.taskClass, primaryModel, fallbackModels, enabled: true });
      flash(`Saved ${p.name}`);
      setEditing((e) => { const n = { ...e }; delete n[p.id]; return n; });
      void refresh();
    } catch (e) { fail(e); }
  }

  async function testProfile(p: ProfileRow) {
    try {
      const res = await api.testModelProfile(p.id);
      flash(`${p.name}: ${res.ok ? "OK" : "failed"}${res.latencyMs != null ? ` · ${res.latencyMs}ms` : ""}`);
    } catch (e) { fail(e); }
  }

  async function savePolicy() {
    if (!workspaceId) return;
    try {
      await api.updatePolicy(workspaceId, { privacyMode, stealthAllowed });
      flash("Policy saved");
    } catch (e) { fail(e); }
  }

  const ENV_KEYS = [
    { key: "DATABASE_URL", hint: "Postgres (pgvector:pg16)" },
    { key: "REDIS_URL", hint: "BullMQ queue" },
    { key: "S3_ENDPOINT", hint: "MinIO / S3 artifacts" },
    { key: "DEEPGRAM_API_KEY", hint: "STT streaming — free sherpa fallback runs without it" },
    { key: "GROQ_API_KEY", hint: "Primary coach routing (free tier wins per SCOREBOARD)" },
    { key: "BAI_API_KEY", hint: "OpenAI-compatible gateway — vision + coach" },
    { key: "EMBEDDING_BASE_URL", hint: "Semantic recall — lexical-hash runs free without it" },
    { key: "SECRET_MASTER_KEY", hint: "Vault envelope encryption" },
  ];

  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <PageHeader
        kicker="Configuration"
        title="Settings"
        description="Providers, model routing, privacy policy, and diagnostics — everything is workspace-scoped and audited."
      />
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}
      {msg && <span className="small" style={{ color: "var(--success)" }}>{msg}</span>}
      {loading && <Skeleton height="120px" />}

      {!loading && (
        <>
          <Section kicker="Providers (BYOK)" title="Bring your own keys">
            <div className="row">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 160 }}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input type="password" placeholder="sk-…" value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button className="primary" onClick={() => void connect()} disabled={!secret}>Connect</button>
            </div>
            <div className="col" style={{ gap: 8 }}>
              {connections.map((c) => (
                <div key={c.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  <span style={{ fontWeight: 550 }}>{c.provider}</span>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="badge ok">connected</span>
                    <button className="ghost" onClick={() => void disconnect(c.id, c.provider)}>Disconnect</button>
                  </span>
                </div>
              ))}
              {connections.length === 0 && (
                <span className="small muted">No providers yet — the free stack (Groq free tier, local sherpa STT, LocalEcho coach) runs without keys.</span>
              )}
            </div>
          </Section>

          <Section kicker="Model routing" title="Primary & fallback per task">
            <span className="small muted">
              Router scoring: 0.35·health + 0.25·latency + 0.20·quality + 0.10·privacy + 0.10·budget − breaker.
              Edit the model descriptors and Test to measure live latency.
            </span>
            {profiles.length === 0 && (
              <span className="small muted">
                No profiles yet — defaults route coach → Groq free tier, STT → Deepgram (if keyed) → sherpa → simulated.
                Create one via <span className="mono">PUT /v1/model-profiles/:id</span>.
              </span>
            )}
            {profiles.map((p) => {
              const draft = editing[p.id] ?? {
                primary: JSON.stringify(p.primaryModel),
                fallbacks: JSON.stringify(p.fallbackModels ?? []),
              };
              const isEditing = editing[p.id] != null;
              return (
                <div key={p.id} className="col" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{p.name} <span className="mono small muted">· {p.taskClass}</span></span>
                    <span className="row" style={{ gap: 8 }}>
                      <button className="ghost" onClick={() => void testProfile(p)}>Test</button>
                      {isEditing
                        ? <button className="primary" onClick={() => void saveProfile(p)}>Save</button>
                        : <button onClick={() => setEditing((e) => ({ ...e, [p.id]: draft }))}>Edit</button>}
                    </span>
                  </div>
                  {isEditing ? (
                    <>
                      <label className="col small" style={{ gap: 4 }}>
                        Primary model (JSON)
                        <textarea rows={2} className="mono" value={draft.primary} onChange={(e) => setEditing((s) => ({ ...s, [p.id]: { ...draft, primary: e.target.value } }))} />
                      </label>
                      <label className="col small" style={{ gap: 4 }}>
                        Fallbacks (JSON array)
                        <textarea rows={2} className="mono" value={draft.fallbacks} onChange={(e) => setEditing((s) => ({ ...s, [p.id]: { ...draft, fallbacks: e.target.value } }))} />
                      </label>
                    </>
                  ) : (
                    <span className="small muted mono">{JSON.stringify(p.primaryModel).slice(0, 120)}</span>
                  )}
                </div>
              );
            })}
          </Section>

          <Section kicker="Privacy & policy" title="Workspace rules">
            <div className="row">
              <label className="col small" style={{ gap: 4, maxWidth: 240 }}>
                Privacy mode
                <select value={privacyMode} onChange={(e) => setPrivacyMode(e.target.value)}>
                  {PRIVACY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <Toggle checked={stealthAllowed} onChange={setStealthAllowed} label="Allow stealth overlay (red-team mode)" />
            </div>
            <span className="small muted">
              <span className="mono">local_only</span> blocks managed providers; <span className="mono">byok_only</span> blocks managed but allows your keys.
            </span>
            <button className="primary" onClick={() => void savePolicy()} style={{ alignSelf: "flex-start" }}>Save policy</button>
          </Section>

          <Section kicker="Environment" title="Server configuration (.env)">
            {ENV_KEYS.map((e) => (
              <div key={e.key} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                <span className="mono" style={{ fontWeight: 600 }}>{e.key}</span>
                <span className="small muted" style={{ flex: 1, textAlign: "right" }}>{e.hint}</span>
              </div>
            ))}
            <span className="small muted">Change in <span className="mono">.env</span> then restart the API. Secrets are never returned by the API — vault refs only.</span>
          </Section>

          <Section kicker="Diagnostics" title="Stealth state">
            <div className="small muted">
              Capture exclusion: {String(stealth.captureExclusion)} · Taskbar hidden: {String(stealth.taskbarHidden)} · Masquerade: {stealth.masquerade}
            </div>
            <div className="row">
              <button onClick={async () => { const s = await stealthEnforceNow(); setStealth(s); }}>Re-enforce stealth</button>
              <button className="ghost" onClick={() => void refresh()}>Refresh</button>
            </div>
            <span className="small muted mono">Enforced at: {stealth.enforcedAtMs ? new Date(stealth.enforcedAtMs).toLocaleTimeString() : "—"}</span>
          </Section>
        </>
      )}
    </div>
  );
}
