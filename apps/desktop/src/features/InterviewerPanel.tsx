import { useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";

interface SheetQuestion {
  question: string;
  intent: string;
  whatGoodLooksLike: string;
  probes: string[];
  difficulty: "warmup" | "core" | "pressure";
}

const DIFF_COLOR: Record<SheetQuestion["difficulty"], string> = {
  warmup: "var(--success)",
  core: "var(--accent)",
  pressure: "var(--warn)",
};

/** Interviewer persona's live aid — replaces the candidate Coaching panel.
 *  Sheet checklist (mark asked), one-click probe suggestions from the live
 *  transcript, and an answer-signal badge. Talk-time meter is shared. */
export default function InterviewerPanel() {
  const { workspaceId, insights, transcript, notify } = useStore();
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [probes, setProbes] = useState<string[]>([]);
  const [signal, setSignal] = useState<"strong" | "shallow" | "off_track" | null>(null);
  const [busy, setBusy] = useState(false);
  const [probeFor, setProbeFor] = useState<string | null>(null);

  // The sheet was persisted at Prep time as a question_sheet insight.
  const sheet = insights.find((i) => i.type === "question_sheet")?.contentJson as
    | { questions?: SheetQuestion[] }
    | undefined;
  const questions = sheet?.questions ?? [];

  async function suggestProbe() {
    if (!workspaceId || busy) return;
    // Context: their last question + the candidate's recent finals.
    const lastQ = [...transcript].reverse().find((t) => t.speaker === "interviewer" && t.isFinal)?.text
      ?? probeFor
      ?? "";
    const answerSoFar = transcript.filter((t) => t.speaker === "user" && t.isFinal).slice(-4).map((t) => t.text).join(" ");
    setBusy(true);
    try {
      const res = await api.verticalPost<{ probes: string[]; signal: "strong" | "shallow" | "off_track" }>(
        "interview-intelligence", "/interviewer/probe", { workspaceId, question: lastQ, answerSoFar },
      );
      setProbes(res.probes);
      setSignal(res.signal);
      setProbeFor(lastQ || null);
      if (res.probes.length === 0) notify("info", "No probe suggestions — the answer may be complete.");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card grid" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="kicker">Interviewer aid</span>
        <button className="primary" disabled={busy} onClick={() => void suggestProbe()} title="Suggest follow-up probes from the live transcript">
          {busy ? "Thinking…" : "Suggest probe"}
        </button>
      </div>

      {signal && (
        <div className="row" style={{ gap: 6 }}>
          <span
            className="badge"
            style={{
              color: signal === "strong" ? "var(--success)" : signal === "off_track" ? "var(--danger)" : "var(--warn)",
              borderColor: signal === "strong" ? "rgba(52,211,153,0.4)" : signal === "off_track" ? "rgba(248,113,113,0.35)" : "rgba(251,191,36,0.35)",
            }}
            title="Live read of the candidate's answer so far"
          >
            answer: {signal}
          </span>
        </div>
      )}

      {probes.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          {probes.map((p, i) => (
            <div key={i} className="row" style={{ gap: 6, alignItems: "flex-start" }}>
              <span className="small" style={{ flex: 1, background: "var(--surface-2)", borderRadius: 8, padding: "6px 10px" }}>{p}</span>
            </div>
          ))}
        </div>
      )}

      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">
          {questions.length === 0
            ? "No question sheet yet — generate one in Prep, or probes will follow the live conversation."
            : `${questions.filter((q) => asked.has(q.question)).length}/${questions.length} asked`}
        </span>
        {questions.map((q, i) => {
          const isAsked = asked.has(q.question);
          return (
            <div
              key={i}
              className="col small"
              style={{
                gap: 4, padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)",
                opacity: isAsked ? 0.5 : 1,
                borderLeft: `2px solid ${DIFF_COLOR[q.difficulty]}`,
              }}
            >
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{q.question}</span>
                <button
                  className={isAsked ? "ghost" : "primary"}
                  style={{ padding: "2px 8px", fontSize: 11, flex: "none" }}
                  onClick={() => setAsked((prev) => {
                    const next = new Set(prev);
                    if (next.has(q.question)) next.delete(q.question); else next.add(q.question);
                    return next;
                  })}
                >
                  {isAsked ? "✓" : "ask"}
                </button>
              </div>
              <span className="muted">{q.whatGoodLooksLike}</span>
              {!isAsked && q.probes.length > 0 && (
                <span className="muted" style={{ fontStyle: "italic" }}>if shallow: {q.probes[0]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
