import { useEffect, useState } from "react";
import { APP_NAME } from "brand";
import { StatusPill } from "@app/ui";
import Studio from "./Studio";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787/v1";

function token() { return localStorage.getItem("app_token"); }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string,string> = { "content-type":"application/json", ...(init.headers as Record<string,string>||{}) };
  const t = token(); if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, {...init, headers});
  const txt = await r.text(); const body = txt?JSON.parse(txt):{}; if(!r.ok) throw new Error((body as {error?:string}).error??String(r.status)); return body as T;
}

type WebScreen = "console" | "studio";

export default function App() {
  const [email,setEmail]=useState(""); const [authed,setAuthed]=useState(!!token());
  const [workspaces,setWorkspaces]=useState<{id:string;name:string}[]>([]);
  const [sessions,setSessions]=useState<{id:string;title:string|null;status:string}[]>([]);
  const [ws,setWs]=useState(""); const [err,setErr]=useState<string|null>(null);
  const [screen, setScreen] = useState<WebScreen>("console");

  async function login(e: React.FormEvent){ e.preventDefault(); const r=await api<{token:string;workspaceId:string}>("/auth/session",{method:"POST",body:JSON.stringify({email})}); localStorage.setItem("app_token",r.token); setAuthed(true); setWs(r.workspaceId); }
  async function load(){ if(!ws) return; try{ const w=await api<{id:string;name:string}[]>("/workspaces"); setWorkspaces(w); const s=await api<{id:string;title:string|null;status:string}[]>(`/interview-sessions?workspaceId=${encodeURIComponent(ws)}`); setSessions(s as never[]);}catch(ex){ setErr(ex instanceof Error?ex.message:String(ex)); } }
  useEffect(()=>{ if(authed) void load(); },[authed,ws]);

  if(!authed) return <div className="col" style={{maxWidth:440,margin:"14vh auto 0"}}>
    <span className="kicker">Console</span>
    <h1 style={{fontSize:26}}>{APP_NAME} <span className="grad-text">admin</span></h1>
    <p className="muted small">Admin and review companion. Same API as the desktop.</p>
    <form onSubmit={login} className="card col fade-in">
      <input placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)} required/>
      <button className="primary" type="submit">Sign in</button>
      {err&&<span className="small" style={{color:"var(--danger)"}}>{err}</span>}
    </form>
  </div>;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="col" style={{ gap: 0 }}>
          <b>{APP_NAME}</b>
          <span className="small muted">Console</span>
        </div>
      </div>
      {(["console", "studio"] as const).map((s) => (
        <button key={s} className={`nav-item${screen === s ? " active" : ""}`} onClick={() => setScreen(s)}>
          <span style={{ textTransform: "capitalize" }}>{s}</span>
        </button>
      ))}
      <div className="foot small muted">
        <div>v0.1.0 · local-first</div>
      </div>
    </aside>
    <main className="content">
      <div className="content-inner">
        {screen === "console" && (
          <div className="col">
            <div className="page-header">
              <div className="titles">
                <span className="kicker">Console</span>
                <h2>{APP_NAME} — Workspaces</h2>
              </div>
              <div className="actions"><button onClick={()=>{localStorage.removeItem("app_token"); setAuthed(false);}}>Sign out</button></div>
            </div>

            <div className="stats">
              <div className="card stat"><span className="label">Workspaces</span><span className="value">{workspaces.length}</span></div>
              <div className="card stat"><span className="label">Sessions</span><span className="value">{sessions.length}</span></div>
            </div>

            <div className="card col">
              <span className="kicker">Workspaces</span>
              <div className="col" style={{gap:6}}>
                {workspaces.map(w=><div key={w.id} className="row small" style={{justifyContent:"space-between"}}><span style={{fontWeight:550}}>{w.name}</span><code className="mono muted">{w.id.slice(0,8)}</code></div>)}
                {workspaces.length===0&&<span className="small muted">None.</span>}
              </div>
            </div>

            <div className="card col">
              <div className="row" style={{justifyContent:"space-between"}}>
                <span className="kicker">Sessions</span>
                <button className="ghost" onClick={()=>void load()}>Refresh</button>
              </div>
              {sessions.length===0&&<span className="small muted">No sessions yet.</span>}
              <div className="col" style={{gap:8}}>
                {sessions.map(s=>(
                  <div key={s.id} className="row" style={{justifyContent:"space-between",borderTop:"1px solid var(--border)",paddingTop:8}}>
                    <div className="col" style={{gap:2}}>
                      <span style={{fontWeight:550,fontSize:13}}>{s.title??"Untitled session"}</span>
                      <code className="mono muted">{s.id.slice(0,8)}</code>
                    </div>
                    <StatusPill status={s.status}/>
                  </div>
                ))}
              </div>
            </div>
            <div className="small muted mono">API: {API}</div>
          </div>
        )}
        {screen === "studio" && <Studio />}
      </div>
    </main>
  </div>;
}
