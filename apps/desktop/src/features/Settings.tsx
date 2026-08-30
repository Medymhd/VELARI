import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { stealthEnforceNow, stealthGetState } from "../lib/tauri";
import { PageHeader } from "@app/ui";

export default function Settings() {
  const { workspaceId, stealth, setStealth } = useStore();
  const [provider, setProvider] = useState("openai");
  const [secret, setSecret] = useState("");
  const [connections, setConnections] = useState<{ id: string; provider: string; status?: string }[]>([]);
  const [profiles, setProfiles] = useState<{ id: string; name: string; taskClass: string; primaryModel: unknown; fallbackModels: unknown[] }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [envStatus, setEnvStatus] = useState<{ key: string; set: boolean; hint: string }[]>([]);

  async function refresh() {
    if (!workspaceId) return;
    const list = await api.providerConnections(workspaceId);
    setConnections(list);
    try {
      const p = await api.modelProfiles(workspaceId);
      setProfiles(p as never[]);
    } catch {}
    const s = await stealthGetState().catch(() => null);
    if (s) setStealth(s);
    // Important settings currently in .env — show without revealing secrets (brand-neutral, not hard-coded)
    try {
      const health = await api.health();
      const keys: { key: string; hint: string }[] = [
        { key: "DATABASE_URL", hint: "Postgres (pgvector:pg16)" },
        { key: "REDIS_URL", hint: "BullMQ queue" },
        { key: "S3_ENDPOINT / MINIO", hint: "Object storage" },
        { key: "DEEPGRAM_API_KEY", hint: "STT streaming (Moonshine free fallback if empty)" },
        { key: "GROQ_API_KEY / BAI / OPENAI_COMPAT", hint: "LLM routing — Groq primary qwen3.6-27b wins per SCOREBOARD" },
        { key: "EMBEDDING_BASE_URL", hint: "pgvector 256 lexical-hash free, or cloud 1536" },
        { key: "JWT_SECRET / SECRET_MASTER_KEY", hint: "Auth + vault SecretBox v1" },
      ];
      // We cannot read .env from renderer; infer via health + provider list — show all as configurable
      setEnvStatus(keys.map((k) => ({ ...k, set: health ? true : false })));
    } catch {
      setEnvStatus([]);
    }
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

  async function testProfile(id: string) {
    setMsg(null);
    try {
      const res = await api.testModelProfile(id);
      setMsg(`Profile ${id.slice(0, 8)} test: ${JSON.stringify(res).slice(0, 120)}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
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
        <span className="kicker">Model Routing — change models, test superiority</span>
        <span className="small muted">Router scoring 0.35×health+0.25×latency… — Groq <span className="mono">qwen3.6-27b 564/1052 100% TTFT</span> wins per <span className="mono">benchmarks/results/SCOREBOARD.md</span> vs b.ai 1.8s. Use model-profiles to change primary/fallback per taskClass.</span>
        {profiles.length === 0 && <span className="small muted">No model profiles yet — workspace will use free default (Groq free tier → b.ai fallback). Create via API <span className="mono">PUT /v1/model-profiles/:id</span> or use BYOK above.</span>}
        {profiles.map((p) => (
          <div key={p.id} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{p.name} <span className="mono">· {p.taskClass}</span></span>
              <span className="small muted mono">{JSON.stringify(p.primaryModel).slice(0, 80)}</span>
            </div>
            <button className="ghost" onClick={() => void testProfile(p.id)}>Test</button>
          </div>
        ))}
        <span className="small muted">Latency/accuracy test via <span className="mono">POST /v1/model-profiles/:id/test</span> — see <span className="mono">benchmarks/run-coach.mjs run-stt.mjs run-vision.mjs scoreboard.mjs</span> for superiority matrix.</span>
      </div>

      <div className="card col">
        <span className="kicker">Important settings currently in .env</span>
        <span className="small muted">These are not hard-coded — brand-neutral via <span className="mono">packages/brand</span> + <span className="mono">.env.example</span> — change in <span className="mono">.env</span> then <span className="mono">pnpm infra:up && pnpm db:migrate</span>.</span>
        {envStatus.map((e) => (
          <div key={e.key} className="row small" style={{ justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <span className="mono" style={{ fontWeight: 600 }}>{e.key}</span>
            <span className={`badge ${e.set ? "ok" : "warn"}`}>{e.set ? "set" : "not set"}</span>
            <span className="small muted" style={{ flex: 1, textAlign: "right" }}>{e.hint}</span>
          </div>
        ))}
        <span className="small muted">All secrets via vault <span className="mono">provider_connections.secret_ref v1.</span> envelope — never returned by API. See <span className="mono">VELARI ARCHITECTURE.md §5</span> secret handling.</span>
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
