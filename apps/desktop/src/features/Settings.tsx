import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { stealthEnforceNow, stealthGetState } from "../lib/tauri";
import { PageHeader, Section, Skeleton, Toggle } from "@app/ui";

interface ProviderRow {
  id: string;
  provider: string;
  hasSecret: boolean;
  metadataJson?: { baseUrl?: string; modelId?: string; fallbackModelIds?: string[] };
}
interface ProfileRow {
  id: string;
  name: string;
  taskClass: string;
  primaryModel: unknown;
  fallbackModels: unknown[];
  enabled?: boolean;
}
type ModelLite = { id: string; name?: string; contextWindow?: number; features?: string[]; pricing?: { input?: number } };
interface RoutingRow {
  profileId: string | null;
  providerId: string;
  model: string;
  fallbacks: { providerId: string; model: string }[];
}

const PROVIDERS = ["openai", "anthropic", "groq", "deepseek", "bai", "deepgram", "openrouter", "openai-compat"] as const;
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  bai: "https://api.b.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const TASK_CLASSES = ["live_coach", "chunk_summary", "research_chat", "vision"] as const;
const PRIVACY_MODES = ["local_only", "byok_only", "managed_allowed"] as const;

/** Capability badges for a selected model — visual, no spam. */
function featureBadges(features?: string[]): string[] {
  const badges: string[] = [];
  if (features?.includes("images")) badges.push("vision");
  if (features?.includes("prompt-cache")) badges.push("cache");
  if (features?.includes("reasoning")) badges.push("reasoning");
  if (features?.includes("video")) badges.push("video");
  if (features?.includes("tools")) badges.push("tools");
  return badges;
}

export default function Settings() {
  const { workspaceId, stealth, setStealth } = useStore();
  const [provider, setProvider] = useState<string>("groq");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [connections, setConnections] = useState<ProviderRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [catalog, setCatalog] = useState<ModelLite[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [modelFilter, setModelFilter] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [testing, setTesting] = useState<Record<string, string | "busy">>({});
  const [routing, setRouting] = useState<Record<string, RoutingRow>>({});
  const [privacyMode, setPrivacyMode] = useState<string>("managed_allowed");
  const [stealthAllowed, setStealthAllowed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isCustom = provider === "openai-compat";
  const effectiveBaseUrl = isCustom ? baseUrl.trim() : (PROVIDER_BASE_URLS[provider] ?? "");

  async function loadCatalog() {
    if (!effectiveBaseUrl) { setCatalogErr("Base URL required"); return; }
    setCatalogBusy(true);
    setCatalogErr(null);
    try {
      const { models } = await api.providerModels({ baseUrl: effectiveBaseUrl, secret: secret || undefined });
      setCatalog(models);
      if (models.length === 0) setCatalogErr("Endpoint returned no models");
    } catch (e) {
      setCatalogErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCatalogBusy(false);
    }
  }

  async function testConnection(id: string) {
    setTesting((t) => ({ ...t, [id]: "busy" }));
    try {
      const r = await api.testProviderConnection(id);
      setTesting((t) => ({ ...t, [id]: r.ok ? `OK · ${r.latencyMs}ms · ${r.model ?? ""}` : `fail: ${r.error ?? "unknown"}` }));
    } catch (e) {
      setTesting((t) => ({ ...t, [id]: `fail: ${e instanceof Error ? e.message : String(e)}` }));
    }
  }

  async function connect() {
    if (!workspaceId || !secret) return;
    try {
      await api.connectProvider({
        workspaceId,
        provider,
        secret,
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(selectedModel ? { modelId: selectedModel } : {}),
      });
      setSecret("");
      setSelectedModel("");
      setCatalog([]);
      flash(`Connected ${provider}${selectedModel ? ` · ${selectedModel}` : ""} — key sealed into the vault`);
      void refresh();
    } catch (e) { fail(e); }
  }

  async function refresh() {
    if (!workspaceId) return;
    setLoading(true);
    setErr(null);
    try {
      setConnections(await api.providerConnections(workspaceId));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    try {
      const rows = (await api.modelProfiles(workspaceId)) as ProfileRow[];
      setProfiles(rows);
      setRouting(Object.fromEntries(
        TASK_CLASSES.map((tc) => {
          const existing = rows.find((p) => p.taskClass === tc);
          const primary = (existing?.primaryModel ?? {}) as { providerId?: string; model?: string };
          const fallbacks = (existing?.fallbackModels ?? []) as { providerId?: string; model?: string }[];
          return [tc, {
            profileId: existing?.id ?? null,
            providerId: primary.providerId ?? "",
            model: primary.model ?? "",
            fallbacks: fallbacks.slice(0, 3).map((f) => ({ providerId: f.providerId ?? "", model: f.model ?? "" })),
          } satisfies RoutingRow];
        }),
      ));
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

  /** Saved connections that can back a routing row (custom compat ones carry baseUrl). */
  function routableConnections(): ProviderRow[] {
    return connections.filter((c) => c.hasSecret);
  }

  async function rowModels(routingProviderId: string): Promise<ModelLite[]> {
    const conn = connections.find((c) => c.provider === routingProviderId && c.hasSecret);
    if (!conn) return [];
    if (conn.metadataJson?.baseUrl || ["openrouter", "groq", "deepseek", "openai", "bai"].includes(conn.provider)) {
      try {
        return (await api.providerModels({ connectionId: conn.id })).models;
      } catch { return []; }
    }
    return [];
  }

  async function saveRoutingRow(taskClass: string) {
    if (!workspaceId) return;
    const row = routing[taskClass];
    if (!row) return;
    const profileId = row.profileId ?? crypto.randomUUID();
    try {
      await api.saveModelProfile(workspaceId, {
        id: profileId,
        name: taskClass,
        taskClass,
        primaryModel: row.providerId && row.model ? { providerId: row.providerId, model: row.model } : {},
        fallbackModels: row.fallbacks
          .filter((f) => f.providerId && f.model)
          .map((f) => ({ providerId: f.providerId, model: f.model })),
      });
      flash(`Saved routing for ${taskClass}`);
      void refresh();
    } catch (e) { fail(e); }
  }

  async function testTaskRow(taskClass: string) {
    const row = routing[taskClass];
    if (!row?.profileId) { fail(`Save ${taskClass} first — its profile id is needed for the probe`); return; }
    try {
      const res = await api.testModelProfile(row.profileId);
      flash(`${taskClass}: ${res.ok ? "OK" : "failed"}${res.latencyMs != null ? ` · ${res.latencyMs}ms` : ""}`);
    } catch (e) { fail(e); }
  }

  async function disconnect(id: string, name: string) {
    try {
      await api.deleteProvider(id);
      flash(`Disconnected ${name}`);
      void refresh();
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

/** Connection → model picker for a routing row. Model list comes from the
 *  provider's live catalog via the server proxy; free-text entry is allowed
 *  (Cline-style) for model ids the catalog doesn't list. */
function RoutingPicker(props: {
  connections: ProviderRow[];
  value: RoutingRow;
  onChange: (next: RoutingRow) => void;
}): ReactNode {
  const [catalogs, setCatalogs] = useState<Record<string, ModelLite[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const uniqueProviders = Array.from(new Map(props.connections.map((c) => [c.provider, c])).values());

  async function ensureCatalog(providerId: string): Promise<void> {
    if (catalogs[providerId]) return;
    const conn = props.connections.find((c) => c.provider === providerId);
    if (!conn) return;
    setBusy(providerId);
    try {
      const { models } = await api.providerModels({ connectionId: conn.id });
      setCatalogs((c) => ({ ...c, [providerId]: models }));
    } catch {
      setCatalogs((c) => ({ ...c, [providerId]: [] }));
    } finally {
      setBusy(null);
    }
  }

  function modelInput(listId: string, modelValue: string, onModelChange: (v: string) => void, providerId: string) {
    const models = catalogs[providerId] ?? [];
    return (
      <>
        <input
          list={listId}
          value={modelValue}
          onChange={(e) => onModelChange(e.target.value)}
          placeholder={busy === providerId ? "loading models…" : models.length ? "model id (search or type)" : "model id"}
          style={{ flex: 1, minWidth: 160 }}
        />
        <datalist id={listId}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name ?? ""}</option>)}
        </datalist>
      </>
    );
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <select
          value={props.value.providerId}
          onChange={(e) => {
            const pid = e.target.value;
            props.onChange({ ...props.value, providerId: pid, model: "" });
            if (pid) void ensureCatalog(pid);
          }}
          style={{ maxWidth: 190 }}
        >
          <option value="">Connection…</option>
          {uniqueProviders.map((c) => (
            <option key={c.provider} value={c.provider}>
              {c.provider}{c.metadataJson?.baseUrl ? " (custom)" : ""}
            </option>
          ))}
        </select>
        {props.value.providerId && modelInput(`models-${props.value.profileId ?? "new"}-primary`, props.value.model, (v) => props.onChange({ ...props.value, model: v }), props.value.providerId)}
      </div>
      {props.value.fallbacks.map((f, i) => (
        <div key={i} className="row" style={{ gap: 8 }}>
          <span className="small muted" style={{ width: 60 }}>fallback {i + 1}</span>
          <select
            value={f.providerId}
            onChange={(e) => {
              const pid = e.target.value;
              const fallbacks = [...props.value.fallbacks];
              fallbacks[i] = { providerId: pid, model: "" };
              props.onChange({ ...props.value, fallbacks });
              if (pid) void ensureCatalog(pid);
            }}
            style={{ maxWidth: 190 }}
          >
            <option value="">Connection…</option>
            {uniqueProviders.map((c) => <option key={c.provider} value={c.provider}>{c.provider}</option>)}
          </select>
          {f.providerId && modelInput(`models-${props.value.profileId ?? "new"}-fb${i}`, f.model, (v) => {
            const fallbacks = [...props.value.fallbacks];
            fallbacks[i] = { providerId: fallbacks[i]?.providerId ?? "", model: v };
            props.onChange({ ...props.value, fallbacks });
          }, f.providerId)}
          <button
            className="ghost"
            onClick={() => props.onChange({ ...props.value, fallbacks: props.value.fallbacks.filter((_, j) => j !== i) })}
          >
            ✕
          </button>
        </div>
      ))}
      {props.value.fallbacks.length < 3 && props.value.providerId && (
        <button
          className="ghost"
          style={{ alignSelf: "flex-start" }}
          onClick={() => props.onChange({ ...props.value, fallbacks: [...props.value.fallbacks, { providerId: "", model: "" }] })}
        >
          + Add fallback
        </button>
      )}
    </div>
  );
}

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
            <div className="row" style={{ flexWrap: "wrap", rowGap: 8 }}>
              <select value={provider} onChange={(e) => { setProvider(e.target.value); setCatalog([]); setSelectedModel(""); }} style={{ maxWidth: 210 }}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p === "openai-compat" ? "OpenAI-compatible (custom)" : p}</option>)}
              </select>
              {isCustom && (
                <input placeholder="https://gateway.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              )}
              <input type="password" placeholder="sk-…" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ maxWidth: 220 }} />
              {(isCustom || PROVIDER_BASE_URLS[provider]) && (
                <button className="ghost" disabled={catalogBusy || !effectiveBaseUrl} onClick={() => void loadCatalog()}>
                  {catalogBusy ? "Loading…" : `Load models${catalog.length ? ` (${catalog.length})` : ""}`}
                </button>
              )}
              <button className="primary" onClick={() => void connect()} disabled={!secret}>Connect</button>
            </div>
            {catalogErr && <span className="small" style={{ color: "var(--danger)" }}>{catalogErr}</span>}
            {catalog.length > 0 && (
              <div className="col" style={{ gap: 6 }}>
                {provider === "openrouter" && (
                  <label className="row small">
                    <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} style={{ width: 16, height: 16 }} />
                    Free models only
                  </label>
                )}
                <div className="row" style={{ gap: 8 }}>
                  <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} style={{ flex: 1 }}>
                    <option value="">{provider === "openrouter" ? "Select model (or endpoint default)…" : "Select model…"}</option>
                    {provider === "openrouter" && <option value="openrouter/auto">openrouter/auto — routes to the best model</option>}
                    {catalog
                      .filter((m) => !freeOnly || m.id.endsWith(":free") || (m.pricing as { input?: number } | undefined)?.input === 0)
                      .filter((m) => !modelFilter || m.id.toLowerCase().includes(modelFilter.toLowerCase()))
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.name ? `${m.name} — ${m.id}` : m.id}</option>
                      ))}
                  </select>
                  <input placeholder="filter…" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} style={{ maxWidth: 140 }} />
                </div>
                {selectedModel && (
                  <span className="small muted">
                    {(() => {
                      const m = catalog.find((c) => c.id === selectedModel);
                      const badges = featureBadges(m?.features);
                      return `${selectedModel}${m?.contextWindow ? ` · ${(m.contextWindow / 1000).toFixed(0)}k ctx` : ""}${badges.length ? ` · ${badges.join(" · ")}` : ""}`;
                    })()}
                  </span>
                )}
              </div>
            )}
            <div className="col" style={{ gap: 8 }}>
              {connections.map((c) => {
                const meta = c.metadataJson;
                return (
                  <div key={c.id} className="col small" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, gap: 4 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 550 }}>
                        {c.provider}{meta?.modelId ? ` · ${meta.modelId}` : ""}{meta?.baseUrl ? ` · ${meta.baseUrl}` : ""}
                      </span>
                      <span className="row" style={{ gap: 8 }}>
                        <button className="ghost" disabled={testing[c.id] === "busy"} onClick={() => void testConnection(c.id)}>
                          {testing[c.id] === "busy" ? "Testing…" : "Test"}
                        </button>
                        <button className="ghost" onClick={() => void disconnect(c.id, c.provider)}>Disconnect</button>
                      </span>
                    </div>
                    {testing[c.id] && testing[c.id] !== "busy" && (
                      <span className="small" style={{ color: testing[c.id]?.startsWith("OK") ? "var(--success)" : "var(--danger)" }}>{testing[c.id]}</span>
                    )}
                  </div>
                );
              })}
              {connections.length === 0 && (
                <span className="small muted">No providers yet — the free stack (Groq free tier, local sherpa STT, LocalEcho coach) runs without keys.</span>
              )}
            </div>
          </Section>

          <Section kicker="Model routing" title="Model per task">
            <span className="small muted">
              Each task class routes through its primary, then fallbacks in order. Pick a connection, then a model from its live catalog.
            </span>
            {routableConnections().length === 0 && (
              <span className="small muted">Connect a provider above first — routing needs at least one key.</span>
            )}
            {TASK_CLASSES.map((tc) => {
              const row = routing[tc];
              if (!row) return null;
              const hasProfile = row.profileId != null || (row.providerId && row.model);
              return (
                <div key={tc} className="col" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }} className="mono small">{tc}</span>
                    <span className="row" style={{ gap: 8 }}>
                      <button className="ghost" disabled={!row.profileId} onClick={() => void testTaskRow(tc)}>Test</button>
                      <button className="primary" disabled={!row.providerId || !row.model} onClick={() => void saveRoutingRow(tc)}>Save</button>
                    </span>
                  </div>
                  <RoutingPicker
                    connections={routableConnections()}
                    value={row}
                    onChange={(next) => setRouting((r) => ({ ...r, [tc]: next }))}
                  />
                  {!hasProfile && <span className="small muted">Not configured — defaults route coach → Groq free tier.</span>}
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
              <button onClick={async () => { try { setStealth(await stealthEnforceNow()); flash("Stealth re-enforced on every window"); } catch (e) { fail(e); } }}>Re-enforce stealth</button>
              <button className="ghost" onClick={() => void refresh()}>Refresh</button>
            </div>
            <span className="small muted mono">Enforced at: {stealth.enforcedAtMs ? new Date(stealth.enforcedAtMs).toLocaleTimeString() : "—"}</span>
          </Section>
        </>
      )}
    </div>
  );
}
