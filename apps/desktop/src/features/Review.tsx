import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { EmptyState, PageHeader, StatusPill } from "@app/ui";

type Bundle = {
  transcript?: { id: string; text: string; sequenceNo: number; confidence?: number; speaker?: string | null }[];
  insights?: { id: string; type: string; contentJson: Record<string, unknown> }[];
  session?: { id: string; title?: string | null; status?: string };
};

function highlight(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "var(--accent)", color: "white", padding: "0 3px", borderRadius: 4 }}>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function InsightCard(props: { type: string; contentJson: Record<string, unknown> }) {
  const c = props.contentJson as {
    detected_question?: string;
    suggested_outline?: string[];
    talking_points?: string[];
    chunk_summary?: string;
    summary?: string;
  };
  return (
    <div className="card subtle col" style={{ gap: 8 }}>
      <span className="badge accent">{props.type}</span>
      {c.detected_question && <div style={{ fontWeight: 600, fontSize: 13 }}>{c.detected_question}</div>}
      {c.chunk_summary && <div className="small" style={{ lineHeight: 1.5 }}>{c.chunk_summary}</div>}
      {(c.suggested_outline?.length ?? 0) > 0 && (
        <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          {c.suggested_outline!.map((o) => <li key={o}>{o}</li>)}
        </ol>
      )}
      {(c.talking_points?.length ?? 0) > 0 && (
        <div className="small muted" style={{ lineHeight: 1.55 }}>{c.talking_points!.join(" · ")}</div>
      )}
      {!c.detected_question && !c.chunk_summary && !c.suggested_outline && (
        <pre className="small mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(props.contentJson, null, 2)}</pre>
      )}
    </div>
  );
}

export default function Review() {
  const { sessionId } = useStore();
  const [data, setData] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!sessionId) return;
    setLoading(true);
    try {
      const bundle = (await api.exportSession(sessionId)) as Bundle;
      setData(bundle);
      setErr(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  /** PDF export (reference `pdfGenerator` parity) via the WebView2 print-to-PDF
   *  dialog: a print-only document is rendered into a hidden iframe. */
  function exportPdf() {
    if (!data) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const summaryInsight = (data.insights ?? []).find((i) => i.type === "session_summary")?.contentJson as
      | { summary?: string; highlights?: string[]; followups?: string[]; questionBank?: string[] }
      | undefined;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Session report</title>
<style>
body { font-family: "Segoe UI", system-ui, sans-serif; margin: 36px; color: #16181d; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
.muted { color: #6b7280; font-size: 12px; }
.seg { border-left: 2px solid #6c7bff; padding-left: 10px; margin: 10px 0; font-size: 13px; }
.who { color: #6c7bff; font-weight: 600; margin-right: 6px; font-size: 11px; text-transform: uppercase; }
.meta { color: #9ca3af; font-size: 11px; }
.insight { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 13px; }
.tag { display: inline-block; background: #eef0ff; color: #4a52d9; border-radius: 999px; padding: 1px 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; }
li { margin: 3px 0; }
@media print { body { margin: 12mm; } }
</style></head><body>
<h1>${esc(data.session?.title ?? "Interview session report")}</h1>
<div class="muted">${esc(String(data.session?.status ?? ""))} · ${new Date().toLocaleString()}</div>
${summaryInsight ? `<h2>Summary</h2><div class="insight">${esc(summaryInsight.summary ?? "")}
${(summaryInsight.highlights ?? []).length ? `<b>Highlights</b><ul>${summaryInsight.highlights!.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
${(summaryInsight.followups ?? []).length ? `<b>Follow-ups</b><ul>${summaryInsight.followups!.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
${(summaryInsight.questionBank ?? []).length ? `<b>Question bank</b><ul>${summaryInsight.questionBank!.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}</div>` : ""}
<h2>Transcript</h2>
${(data.transcript ?? []).map((t) => `<div class="seg">${t.speaker ? `<span class="who">${esc(t.speaker)}</span>` : ""}${esc(t.text)}<div class="meta">#${t.sequenceNo}${t.confidence ? ` · ${Math.round(t.confidence * 100)}%` : ""}</div></div>`).join("")}
<h2>Insights</h2>
${(data.insights ?? []).map((i) => `<div class="insight"><span class="tag">${esc(i.type ?? "insight")}</span><pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(JSON.stringify(i.contentJson, null, 1))}</pre></div>`).join("")}
</body></html>`;
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.appendChild(frame);
    frame.srcdoc = doc;
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 5_000);
    };
  }

  const filteredTranscript = useMemo(() => {
    const list = data?.transcript ?? [];
    if (!q) return list;
    const lower = q.toLowerCase();
    return [...list]
      .map((t) => ({ t, score: (t.text.toLowerCase().match(new RegExp(lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t);
  }, [data, q]);

  const filteredInsights = useMemo(() => {
    const list = data?.insights ?? [];
    if (!q) return list;
    const lower = q.toLowerCase();
    return list.filter((i) => JSON.stringify(i.contentJson).toLowerCase().includes(lower));
  }, [data, q]);

  if (!sessionId) {
    return <EmptyState title="No session selected" description="Open a completed session from Home to review its transcript and coaching insights." />;
  }

  return (
    <div className="col">
      <PageHeader
        kicker="Post-session"
        title={data?.session?.title ? `Review — ${data.session.title}` : "Review"}
        description="Full transcript and coaching insights. Search ranks lexically; vector recall lands with pgvector."
        actions={
          <>
            <button className="ghost" onClick={() => exportPdf()} disabled={!data}>
              Export PDF
            </button>
            <button className="primary" onClick={() => void load()} disabled={loading}>
              {loading ? "Loading…" : "Load export"}
            </button>
          </>
        }
      />

      {data?.session?.status && (
        <div className="row" style={{ marginBottom: 4 }}>
          <StatusPill status={data.session.status} />
        </div>
      )}
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err}</span>}

      {data && (
        <>
          <div className="card row">
            <input placeholder="Search transcript & insights…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
            <span className="badge">{filteredTranscript.length} / {(data.transcript ?? []).length} segments</span>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1.2fr 0.8fr" }}>
            <div className="card col">
              <span className="kicker">Transcript</span>
              <div className="scroll col" style={{ gap: 10, maxHeight: "48vh" }}>
                {filteredTranscript.length === 0 && <span className="small muted">No matches.</span>}
                {filteredTranscript.map((t) => (
                  <div key={t.id} className="fade-in" style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 10 }}>
                    <div style={{ fontSize: 13 }}>{highlight(t.text, q)}</div>
                    <div className="small muted mono">#{t.sequenceNo}{t.confidence ? ` · ${(t.confidence * 100).toFixed(0)}%` : ""}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card col">
              <span className="kicker">Insights</span>
              <div className="scroll col" style={{ gap: 10, maxHeight: "48vh" }}>
                {filteredInsights.length === 0 && <span className="small muted">No matches.</span>}
                {filteredInsights.map((ins) => (
                  <InsightCard key={ins.id} type={ins.type} contentJson={ins.contentJson} />
                ))}
              </div>
            </div>
          </div>

          <details className="card">
            <summary className="small muted" style={{ cursor: "pointer" }}>Raw bundle</summary>
            <pre className="small mono" style={{ overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify(data, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}
