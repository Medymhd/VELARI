import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { stealthEnforceNow, stealthGetState } from "../lib/tauri";
import { PageHeader } from "@app/ui";

export default function Settings() {
  const { workspaceId, stealth, setStealth } = useStore();
  const [provider, setProvider] = useState("openai");
  const [secret, setSecret] = useState("");
  const [connections, setConnections] = useState<{ id: string; provider: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    if (!workspaceId) return;
    const list = await api.providerConnections(workspaceId);
    setConnections(list);
    const s = await stealthGetState().catch(() => null);
    if (s) setStealth(s);
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  async function connect() {
    if (!workspaceId || !secret) return;
    await api.connectProvider({ workspaceId, provider, secret });
    setSecret("");
    setMsg(`Connected ${provider}`);
    void refresh();
  }

  return (
    <div className="col" style={{ maxWidth: 660 }}>
      <PageHeader
        kicker="Configuration"
        title="Settings"
        description="Bring your own keys — they are envelope-encrypted and never returned by the API."
      />

      <div className="card col">
        <span className="kicker">Providers (BYOK)</span>
        <div className="row">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
            <option value="deepseek">DeepSeek</option>
            <option value="bai">b.ai</option>
          </select>
          <input type="password" placeholder="sk-…" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button className="primary" onClick={() => void connect()} disabled={!secret}>Connect</button>
        </div>
        {msg && <span className="small" style={{ color: "var(--success)" }}>{msg}</span>}
        <div className="divider" />
        <div className="col" style={{ gap: 8 }}>
          {connections.map((c) => (
            <div key={c.id} className="row small" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 550 }}>{c.provider}</span>
              <span className="badge ok">connected</span>
            </div>
          ))}
          {connections.length === 0 && (
            <span className="small muted">No providers connected — the free/open stack (Groq free tier, local models, simulated fallbacks) is used.</span>
          )}
        </div>
      </div>

      <div className="card col">
        <span className="kicker">Diagnostics</span>
        <div className="small muted">
          Capture exclusion: {String(stealth.captureExclusion)} · Taskbar hidden: {String(stealth.taskbarHidden)} · Masquerade: {stealth.masquerade}
        </div>
        <div className="row">
          <button onClick={async () => { const s = await stealthEnforceNow(); setStealth(s); }}>Re-enforce stealth</button>
          <button className="ghost" onClick={() => void refresh()}>Refresh</button>
        </div>
        <span className="small muted mono">Enforced at: {stealth.enforcedAtMs ? new Date(stealth.enforcedAtMs).toLocaleTimeString() : "—"}</span>
      </div>
    </div>
  );
}
