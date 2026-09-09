import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isDefaultSessionTitle, useStore } from "../state/store";
import { PageHeader } from "@app/ui";

interface SheetQuestion {
  question: string;
  intent: string;
  whatGoodLooksLike: string;
  probes: string[];
  difficulty: "warmup" | "core" | "pressure";
}

interface QuestionSheet {
  questions: SheetQuestion[];
}

interface ContextRow {
  id: string;
  kind: string;
  title: string | null;
  content: string;
}

const DIFF_STYLE: Record<SheetQuestion["difficulty"], { color: string; borderColor: string }> = {
  warmup: { color: "var(--success)", borderColor: "rgba(52,211,153,0.4)" },
  core: { color: "var(--accent)", borderColor: "rgba(108,123,255,0.4)" },
  pressure: { color: "var(--warn)", borderColor: "rgba(251,191,36,0.4)" },
};

/** File → base64 (no data: prefix) for server-side extraction. */
async function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`could not read ${f.name}`));
    r.readAsDataURL(f);
  });
}

/** Interviewer persona home — Prep. Same pipeline the candidate uses for their
 *  own prep (session contexts: cv/jd, server-side pdf/docx/xlsx extraction),
 *  pointed the other way: the app crafts the questions instead of the answers. */
export default function Prep() {
  const { workspaceId, setSession, setScreen, notify, resetLive } = useStore();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [contexts, setContexts] = useState<ContextRow[]>([]);
  const [sheet, setSheet] = useState<QuestionSheet | null>(null);
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The title this Prep session was created with — auto-naming only fires
   *  while it is still the placeholder (user-typed names are never touched). */
  const createdTitleRef = useRef<string | null>(null);
  const titledRef = useRef<string | null>(null);

  /** Model-generated title from CV/JD (+ transcript when present). Silent on
   *  failure — a name is garnish, never a blocker. */
  async function autoName(sid: string) {
    const { workspaceId: ws } = useStore.getState();
    if (!ws || titledRef.current === sid) return;
    titledRef.current = sid;
    try {
      const res = await api.verticalPost<{ title: string; generatedBy: string }>(
        "interview-intelligence", "/session/suggest-title", { workspaceId: ws, sessionId: sid },
      );
      if (!res.title) return;
      await api.patchSession(sid, { title: res.title });
      setSession(sid, undefined, res.title);
      notify("success", `Named "${res.title}" — rename anytime`);
    } catch { /* best-effort */ }
  }

  // Reload contexts when a sheet session is active (and after uploads).
  async function refreshContexts(sid: string) {
    try { setContexts(await api.sessionContexts(sid)); } catch { /* best-effort */ }
  }

  useEffect(() => {
    if (sessionId) void refreshContexts(sessionId);
  }, [sessionId]);

  async function create() {
    if (!workspaceId) return;
    setCreating(true);
    try {
      const createdTitle = title.trim() || "Interviewer session";
      const s = await api.createSession({
        workspaceId,
        title: createdTitle,
        consentStatus: "confirmed",
        metadataJson: { kind: "interviewer" },
      });
      resetLive();
      setSession(s.id, "draft", createdTitle);
      createdTitleRef.current = createdTitle;
      setSessionId(s.id);
      setTitle("");
      setSheet(null);
      setAsked(new Set());
      setContexts([]);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setCreating(false);
    }
  }

  async function addFiles(kind: "cv" | "jd", files: FileList | null) {
    if (!sessionId || !files || files.length === 0) return;
    setBusy(true);
    try {
      const payload = await Promise.all(Array.from(files).map(async (f) => ({ name: f.name, base64: await fileToBase64(f) })));
      await api.addSessionContext(sessionId, { kind, files: payload });
      notify("success", `${kind.toUpperCase()} added — extraction runs server-side`);
      await refreshContexts(sessionId);
      // First materials in → the model names the session from them, unless
      // the user already gave it a real name.
      if (isDefaultSessionTitle(createdTitleRef.current)) void autoName(sessionId);
    } catch (ex) {
      notify("error", ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function addText(kind: "cv" | "jd", text: string) {
    if (!sessionId || !text.trim()) return;
    setBusy(true);
    try {
      await api.addSessionContext(sessionId, { kind, content: text.trim() });
      notify("success", `${kind.toUpperCase()} added`);
      await refreshContexts(sessionId);
      if (isDefaultSessionTitle(createdTitleRef.current)) void autoName(sessionId);
    } catch (ex) {
      notify("error", ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!workspaceId || !sessionId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.verticalPost<{ sheet: QuestionSheet; generatedBy: "llm" | "offline"; hasContexts: boolean }>(
        "interview-intelligence", "/interviewer/sheet", { workspaceId, sessionId, count: 8 },
      );
      setSheet(res.sheet);
      setAsked(new Set());
      if (!res.hasContexts) {
        notify("info", "No CV/JD found — using a generic laddered sheet. Upload them for a personalized one.");
      } else if (res.generatedBy === "offline") {
        notify("info", "Provider unavailable — generated a keyword-driven sheet offline.");
      } else {
        notify("success", `${res.sheet.questions.length} questions crafted from the CV + JD`);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (!sessionId) return;
    setScreen("live");
  }

  const hasCv = contexts.some((c) => c.kind === "cv");
  const hasJd = contexts.some((c) => c.kind === "jd");

  return (
    <div className="col">
      <PageHeader
        kicker="Interviewer mode"
        title="Prep"
        description="Upload the candidate's CV and the job description — the app crafts a laddered question sheet (warmup → core → pressure) with what-good-looks-like for each answer."
      />

      {!sessionId ? (
        <div className="card col" style={{ gap: 10 }}>
          <span className="kicker">New interviewer session</span>
          <div className="row">
            <input
              placeholder="Candidate / role name (e.g. 'Senior Backend — A. Okafor')"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={creating} onClick={() => void create()}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          <span className="small muted">Creates a normal session tagged kind=interviewer — Review surfaces it like any other.</span>
        </div>
      ) : (
        <>
          <div className="card col" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="kicker">Candidate materials</span>
              <span className="row small" style={{ gap: 6 }}>
                <span className="badge" style={{ color: hasCv ? "var(--success)" : undefined }}>{hasCv ? "✓ CV" : "CV"}</span>
                <span className="badge" style={{ color: hasJd ? "var(--success)" : undefined }}>{hasJd ? "✓ JD" : "JD"}</span>
              </span>
            </div>

            <ContextInput
              kind="cv"
              label="CV"
              onText={(text) => void addText("cv", text)}
              onFiles={(files) => void addFiles("cv", files)}
              busy={busy}
              rowCount={contexts.filter((c) => c.kind === "cv").length}
            />
            <ContextInput
              kind="jd"
              label="Job description"
              onText={(text) => void addText("jd", text)}
              onFiles={(files) => void addFiles("jd", files)}
              busy={busy}
              rowCount={contexts.filter((c) => c.kind === "jd").length}
            />

            <div className="row" style={{ gap: 8 }}>
              <button className="primary" disabled={busy} onClick={() => void generate()}>
                {busy ? "Crafting…" : sheet ? "Regenerate sheet" : "Generate question sheet"}
              </button>
              {sheet && (
                <button className="ghost" onClick={start}>
                  Start interview →
                </button>
              )}
            </div>
            {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}
          </div>

          {sheet && (
            <div className="col" style={{ gap: 10 }}>
              {(["warmup", "core", "pressure"] as const).map((diff) => {
                const qs = sheet.questions.filter((q) => q.difficulty === diff);
                if (qs.length === 0) return null;
                return (
                  <div key={diff} className="card col" style={{ gap: 8 }}>
                    <span className="kicker" style={{ textTransform: "capitalize" }}>{diff} questions</span>
                    {qs.map((q, i) => (
                      <div
                        key={`${diff}-${i}`}
                        className="col"
                        style={{
                          gap: 6, padding: "10px 12px", borderRadius: 8, background: "var(--surface-2)",
                          opacity: asked.has(q.question) ? 0.55 : 1,
                          borderLeft: `2px solid ${DIFF_STYLE[q.difficulty].color}`,
                        }}
                      >
                        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{q.question}</div>
                          <button
                            className={asked.has(q.question) ? "ghost" : "primary"}
                            style={{ padding: "3px 10px", fontSize: 12, flex: "none" }}
                            onClick={() => setAsked((prev) => {
                              const next = new Set(prev);
                              if (next.has(q.question)) next.delete(q.question); else next.add(q.question);
                              return next;
                            })}
                          >
                            {asked.has(q.question) ? "Asked ✓" : "Mark asked"}
                          </button>
                        </div>
                        <div className="small muted"><b>Why:</b> {q.intent}</div>
                        <div className="small muted"><b>Good answer:</b> {q.whatGoodLooksLike}</div>
                        {q.probes.length > 0 && (
                          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                            {q.probes.map((p, j) => <span key={j} className="badge">probe: {p}</span>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Reusable cv/jd input — text paste + file upload, mirroring the live-session
 *  prep panel so both personas share one mental model. */
function ContextInput(props: {
  kind: "cv" | "jd";
  label: string;
  rowCount: number;
  busy: boolean;
  onText: (text: string) => void;
  onFiles: (files: FileList | null) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <input
          placeholder={props.kind === "cv" ? "Paste the candidate's CV text…" : "Paste the job description…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onText(text)}
          style={{ flex: 1 }}
        />
        <button className="ghost" disabled={props.busy || !text.trim()} onClick={() => { props.onText(text); setText(""); }}>Add</button>
        <label className="ghost" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border-strong)" }}>
          Upload
          <input
            type="file"
            accept=".pdf,.txt,.md,.docx,.xls,.xlsx,.csv"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { props.onFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
        {props.rowCount > 0 && <span className="badge">{props.rowCount} added</span>}
      </div>
    </div>
  );
}
