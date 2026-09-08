import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { PageHeader, Skeleton } from "@app/ui";

interface EvalResult {
  score: number;
  strengths: string[];
  weaknesses: string[];
  strengthened: string;
}

interface StoryHit {
  id: string;
  question: string;
  answer: string;
  score: number | null;
  similarity: number;
  duplicate: boolean;
}

interface Round {
  question: string;
  depth: number;
  answer?: string;
  eval?: EvalResult;
  followUp?: string;
}

interface ArenaTrendEntry {
  sessionId: string;
  metrics: {
    fillerRate: number;
    wpm: number | null;
    starShare: number;
  };
  verdicts: {
    filler: "good" | "ok" | "warn";
    pace: "good" | "ok" | "warn" | null;
    star: "good" | "ok" | "warn";
  };
}

const MODES = [
  { id: "job-seeker", label: "Job interview" },
  { id: "technical", label: "Technical" },
  { id: "general", label: "General" },
  { id: "sales", label: "Sales call" },
  { id: "leadership", label: "Leadership" },
];

/** Arena — the AI interviews you. Question → typed answer → 0-10 score with a
 *  coached rewrite of what a 10 sounds like; weak answers earn follow-up
 *  probes, exactly like a real interviewer. Questions are read aloud. */
export default function Arena() {
  const { workspaceId, notify } = useStore();
  const [mode, setMode] = useState("job-seeker");
  const [role, setRole] = useState("");
  const [seniority, setSeniority] = useState("");
  const [rounds, setRounds] = useState<Round[]>([]);
  const [current, setCurrent] = useState("");
  const [currentDepth, setCurrentDepth] = useState(0);
  const [phase, setPhase] = useState<"idle" | "asking" | "answering" | "evaluating">("idle");
  const [typed, setTyped] = useState("");
  const [useVoice, setUseVoice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [predictions, setPredictions] = useState<string[]>([]);
  const [predictBusy, setPredictBusy] = useState(false);
  const [jd, setJd] = useState("");
  const [stories, setStories] = useState<StoryHit[]>([]);
  const [trend, setTrend] = useState<ArenaTrendEntry[]>([]);
  const askedRef = useRef<string[]>([]);

  useEffect(() => () => { try { speechSynthesis.cancel(); } catch { /* no-op */ } }, []);

  // Progress trend across recent sessions — proof the drills are working.
  useEffect(() => {
    if (!workspaceId) return;
    api.verticalPost<{ trend: ArenaTrendEntry[] }>("interview-intelligence", "/arena/analytics", { workspaceId })
      .then((res) => setTrend(Array.isArray(res.trend) ? res.trend : []))
      .catch(() => setTrend([])); // trend is garnish — never block practice on it
  }, [workspaceId]);

  async function recallStories(q: string) {
    if (!workspaceId || !q.trim()) { setStories([]); return; }
    try {
      const res = await api.verticalPost<{ stories: StoryHit[] }>("interview-intelligence", "/arena/story-recall", {
        workspaceId, question: q,
      });
      setStories(res.stories ?? []);
    } catch { setStories([]); }
  }

  async function predict() {
    if (!workspaceId) { notify("error", "Sign in first"); return; }
    if (!role.trim() && !jd.trim()) { notify("error", "Enter a target role or paste the job description"); return; }
    setPredictBusy(true);
    try {
      const res = await api.verticalPost<{ questions: string[] }>("interview-intelligence", "/arena/predict", {
        workspaceId, role, seniority, jd, count: 10,
      });
      setPredictions(res.questions);
      notify("success", `${res.questions.length} predicted questions — drill them before the real thing`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally { setPredictBusy(false); }
  }

  async function nextQuestion(depth: number, parentQuestion?: string, userAnswer?: string) {
    if (!workspaceId) { notify("error", "Sign in first"); return; }
    setBusy(true);
    setPhase("asking");
    try {
      const res = await api.verticalPost<{ question: string }>("interview-intelligence", "/arena/question", {
        workspaceId, mode, role, seniority,
        previousQuestions: askedRef.current,
        depth,
        ...(depth > 0 ? { parentQuestion, userAnswer } : {}),
      });
      askedRef.current = [...askedRef.current, res.question];
      setCurrent(res.question);
      void recallStories(res.question);
      setCurrentDepth(depth);
      setTyped("");
      setPhase("answering");
      if (useVoice) speak(res.question);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally { setBusy(false); }
  }

  async function submitAnswer() {
    const q = currentDepth === 0 ? current : rounds[rounds.length - 1]?.question ?? "";
    const answer = typed.trim();
    if (!q || !answer || busy) return;
    setBusy(true);
    setPhase("evaluating");
    try {
      const res = await api.verticalPost<EvalResult>("interview-intelligence", "/arena/evaluate", {
        workspaceId, question: q, answer, mode,
      });
      const round: Round = currentDepth === 0
        ? { question: q, depth: 0, answer, eval: res }
        : { question: q, depth: currentDepth, answer, eval: res, followUp: current };
      setRounds((prev) => [...prev, round]);
      const earnedFollowUp = res.score <= 6 && currentDepth < 2;
      setTyped("");
      setCurrent("");
      setPhase("idle");
      if (earnedFollowUp) {
        // Weak answer: the interviewer presses — with the score card still visible.
        void nextQuestion(currentDepth + 1, q, answer);
      } else {
        notify(res.score >= 8 ? "success" : "info", `Scored ${res.score}/10${res.score >= 8 ? " — excellent" : " — read the coached rewrite below"}`);
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setPhase("answering");
    } finally { setBusy(false); }
  }

  function speak(text: string) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      speechSynthesis.speak(u);
    } catch { /* no voices — silent text fallback */ }
  }

  const avg = rounds.length > 0
    ? Math.round((rounds.reduce((a, r) => a + (r.eval?.score ?? 0), 0) / rounds.length) * 10) / 10
    : null;

  return (
    <div className="col">
      <PageHeader
        kicker="Interview Intelligence"
        title="Arena — practice mode"
        description="The AI interviews you. Every answer is scored 0-10 with a coached rewrite of what a 10 sounds like. Weak answers earn follow-up probes."
      />

      <div className="card col" style={{ gap: 10 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ maxWidth: 180 }}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <input placeholder="Target role (optional) — e.g. AI Training Specialist" value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <select value={seniority} onChange={(e) => setSeniority(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="">Any level</option>
            <option value="junior">Junior</option>
            <option value="mid">Mid-level</option>
            <option value="senior">Senior</option>
            <option value="lead">Lead / Staff</option>
          </select>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <button
            className="primary"
            disabled={busy || phase === "asking"}
            onClick={() => void nextQuestion(0)}
          >
            {rounds.length === 0 ? "Start interview" : "Next question"}
          </button>
          <label className="row small" style={{ gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={useVoice} onChange={(e) => setUseVoice(e.target.checked)} />
            Read questions aloud
          </label>
          {avg !== null && (
            <span className="row small" style={{ gap: 6, marginLeft: "auto" }}>
              <span className="muted">Session average</span>
              <span className="badge" style={{ color: scoreColor(avg), borderColor: "rgba(124,124,255,0.4)" }}>{avg}/10 · {rounds.length} answered</span>
            </span>
          )}
        </div>
        <span className="small muted">Answer out loud, then type what you said (or type directly) — the score judges content, not transcription typos.</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Paste the job description for question prediction (optional)…"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
            title="The predictor mixes intro/behavioral, role-specific, and pressure questions from the JD"
          />
          <button className="ghost" disabled={predictBusy || (!role.trim() && !jd.trim())} onClick={() => void predict()}>
            {predictBusy ? "Predicting…" : predictions.length > 0 ? `Re-predict (${predictions.length})` : "Predict questions"}
          </button>
        </div>
        {predictions.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <span className="kicker">Question horizon — {predictions.length} predicted</span>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {predictions.map((q, i) => (
                <button
                  key={i}
                  className="ghost"
                  style={{ fontSize: 12, maxWidth: 420, textAlign: "left", borderColor: askedRef.current.includes(q) ? "var(--success)" : undefined }}
                  title={askedRef.current.includes(q) ? "Already drilled this session" : "Practice this question now"}
                  onClick={() => {
                    askedRef.current = [...askedRef.current, q];
                    setCurrent(q);
                    setCurrentDepth(0);
                    setTyped("");
                    setPhase("answering");
                    if (useVoice) speak(q);
                  }}
                >
                  {askedRef.current.includes(q) ? "✓ " : ""}{q.slice(0, 90)}{q.length > 90 ? "…" : ""}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {phase === "asking" && <Skeleton height="90px" />}

      {trend.length > 1 && (
        <div className="card row" style={{ gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <span className="kicker">Progress trend · last {trend.length} sessions</span>
          {trend.map((t, i) => (
            <div key={t.sessionId} className="col small" style={{ gap: 2, minWidth: 86 }}>
              <span className="muted mono">#{i + 1}</span>
              <span>
                {t.metrics.fillerRate} fill<span style={{ color: verdictColor(t.verdicts.filler) }}> · </span>
                {t.metrics.wpm == null ? "—" : t.metrics.wpm} wpm<span style={{ color: verdictColor(t.verdicts.pace) }}> · </span>
                {Math.round(t.metrics.starShare * 100)}% star
              </span>
            </div>
          ))}
        </div>
      )}

      {rounds.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          {rounds.map((r, i) => (
            <div key={i} className="card col" style={{ gap: 8, borderColor: r.eval ? scoreColor(r.eval.score) : undefined, borderWidth: 2 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="kicker">{r.depth === 0 ? `Question ${i + 1}` : "Follow-up probe"}</span>
                {r.eval && <span className="badge" style={{ color: scoreColor(r.eval.score), borderColor: "rgba(124,124,255,0.4)" }}>{r.eval.score}/10</span>}
              </div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{r.depth === 0 ? r.question : r.followUp}</div>
              {r.answer && (
                <div className="small" style={{ background: "var(--surface-2)", borderRadius: 8, padding: 10, whiteSpace: "pre-wrap" }}>
                  <b>Your answer</b>
                  <div style={{ marginTop: 4 }}>{r.answer}</div>
                </div>
              )}
              {r.eval && (
                <div className="col" style={{ gap: 6, fontSize: 13 }}>
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    {r.eval.strengths.map((s, j) => <span key={`s${j}`} className="badge" style={{ color: "var(--success)", borderColor: "rgba(52,211,153,0.4)" }}>+ {s}</span>)}
                    {r.eval.weaknesses.map((w, j) => <span key={`w${j}`} className="badge" style={{ color: "#fbbf24", borderColor: "rgba(251,191,36,0.4)" }}>− {w}</span>)}
                  </div>
                  <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: 10, whiteSpace: "pre-wrap" }}>
                    <b>What a 10 sounds like</b>
                    <div style={{ marginTop: 4 }}>{r.eval.strengthened}</div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {current && phase === "answering" && (
        <div className="card col" style={{ gap: 8, borderColor: "var(--accent)", borderWidth: 2 }}>
          <span className="kicker">{currentDepth === 0 ? "Answer this" : "The interviewer pressed — answer this"}</span>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{current}</div>
          {stories.length > 0 && (
            <div className="col" style={{ gap: 4, background: "var(--surface-2)", borderRadius: 8, padding: 10 }}>
              {stories.some((s) => s.duplicate) ? (
                <span className="small" style={{ color: "#fbbf24" }}>⚠ You answered this before — vary the story or the angle.</span>
              ) : (
                <span className="small muted">Your story bank has {stories.length} related answer{stories.length > 1 ? "s" : ""}:</span>
              )}
              {stories.slice(0, 2).map((s) => (
                <details key={s.id}>
                  <summary className="small" style={{ cursor: "pointer" }}>
                    {s.duplicate ? "✓ " : ""}{s.question.slice(0, 80)}{s.score != null ? ` — scored ${s.score}/10` : ""}
                  </summary>
                  <div className="small muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{s.answer.slice(0, 400)}{s.answer.length > 400 ? "…" : ""}</div>
                </details>
              ))}
            </div>
          )}
          <textarea
            rows={4}
            placeholder="Type your answer — write it the way you would say it…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="row" style={{ gap: 8 }}>
            <button className="primary" disabled={!typed.trim() || busy} onClick={() => void submitAnswer()}>
              {busy ? "Scoring…" : "Submit answer"}
            </button>
            <button className="ghost" onClick={() => { setCurrent(""); setPhase("idle"); }}>Skip</button>
            <button className="ghost" title="Re-read the question aloud" onClick={() => speak(current)}>🔊 Repeat</button>
          </div>
        </div>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 8) return "var(--success)";
  if (score >= 6) return "#fbbf24";
  return "var(--danger)";
}

function verdictColor(v: "good" | "ok" | "warn" | null): string {
  if (v === "good") return "var(--success)";
  if (v === "warn") return "var(--danger)";
  if (v === "ok") return "var(--warn)";
  return "var(--muted)";
}
