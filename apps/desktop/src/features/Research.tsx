import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { PageHeader, Skeleton } from "@app/ui";

interface ChatRow { id: string; title: string; createdAt: string }
interface Msg { id: string; role: "user" | "assistant"; content: string; providerId?: string; createdAt: string }

const VERTICAL = "research";

/** Lightweight markdown-ish renderer — code fences, inline code, bold, headers,
 *  bullets. No dependency; output is React nodes, never HTML injection. */
function renderContent(text: string) {
  const blocks = text.split(/```/);
  return blocks.map((block, i) => {
    if (i % 2 === 1) {
      // Code fence: first line may name the language.
      const nl = block.indexOf("\n");
      const lang = nl > 0 && nl < 24 ? block.slice(0, nl).trim() : "";
      const code = nl > 0 ? block.slice(nl + 1) : block;
      return (
        <pre key={i} className="mono" style={{ background: "rgba(0,0,0,0.35)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", overflowX: "auto", fontSize: 12, margin: "6px 0" }}>
          {lang && <span className="small muted" style={{ display: "block", marginBottom: 4 }}>{lang}</span>}
          {code.trimEnd()}
        </pre>
      );
    }
    return block.split("\n").map((line, j) => {
      const key = `${i}-${j}`;
      const trimmed = line.trim();
      if (!trimmed) return <div key={key} style={{ height: 6 }} />;
      if (/^#{1,3}\s/.test(trimmed)) {
        return <div key={key} style={{ fontWeight: 700, fontSize: 14, marginTop: 8 }}>{trimmed.replace(/^#+\s/, "")}</div>;
      }
      if (/^[-*•]\s/.test(trimmed)) {
        return (
          <div key={key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", flex: "none" }}>•</span>
            <span>{inline(trimmed.replace(/^[-*•]\s/, ""))}</span>
          </div>
        );
      }
      if (/^\d+[.)]\s/.test(trimmed)) {
        const n = trimmed.match(/^(\d+)[.)]/)![1];
        return (
          <div key={key} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", flex: "none", minWidth: 16 }}>{n}.</span>
            <span>{inline(trimmed.replace(/^\d+[.)]\s/, ""))}</span>
          </div>
        );
      }
      return <div key={key}>{inline(line)}</div>;
    });
  });
}

function inline(text: string) {
  // **bold** and `code` — minimal, safe (plain text nodes only).
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return <span key={i} className="mono" style={{ background: "rgba(var(--accent-rgb), 0.12)", borderRadius: 4, padding: "1px 5px" }}>{p.slice(1, -1)}</span>;
    }
    return p;
  });
}

export default function Research() {
  const { workspaceId, notify } = useStore();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false); // typing indicator (assistant turn in flight)
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  async function loadChats() {
    if (!workspaceId) return;
    try {
      const res = await api.verticalGet<{ chats: ChatRow[] }>(VERTICAL, `/chats?workspaceId=${encodeURIComponent(workspaceId)}`);
      setChats(res.chats ?? []);
    } catch { /* api down — the composer still works once it is up */ }
  }

  useEffect(() => { void loadChats(); }, [workspaceId]);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    setLoading(true);
    api.verticalGet<{ messages: Msg[] }>(VERTICAL, `/chats/${activeId}/messages?workspaceId=${encodeURIComponent(workspaceId ?? "")}`)
      .then((res) => setMessages(res.messages ?? []))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [activeId, workspaceId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setPending(true);
    setNotice(null);
    // Optimistic user turn — the thread reacts instantly instead of dead air
    // for the whole generation window.
    const optimistic: Msg = { id: `opt-${Date.now()}`, role: "user", content: trimmed, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    setQuestion("");
    try {
      let chatId = activeId;
      if (!chatId) {
        const created = await api.verticalPost<{ chat: ChatRow }>(VERTICAL, "/chats", { workspaceId, question: trimmed });
        chatId = created.chat.id;
        setActiveId(chatId);
        setChats((prev) => [created.chat, ...prev]);
      }
      const res = await api.verticalPost<{ userMsg: Msg; assistantMsg: Msg }>(
        VERTICAL,
        `/chats/${chatId}/messages`,
        { workspaceId, question: trimmed },
      );
      setMessages((prev) => [...prev.filter((m) => m.id !== optimistic.id), res.userMsg, res.assistantMsg]);
    } catch (e) {
      // Roll back the optimistic turn so the thread never shows a phantom ask.
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setQuestion(trimmed); // restore the draft — the user shouldn't retype
      const raw = e instanceof Error ? e.message : String(e);
      setNotice(
        raw.includes("no_provider")
          ? "No provider configured — connect a key in Settings → Providers (BYOK). The free local rung routes automatically once the API has one."
          : raw,
      );
    } finally {
      setBusy(false);
      setPending(false);
    }
  }

  async function deleteChat(id: string) {
    try {
      await api.verticalDelete(VERTICAL, `/chats/${id}?workspaceId=${encodeURIComponent(workspaceId ?? "")}`);
      setChats((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) { setActiveId(null); setMessages([]); }
      notify("success", "Thread deleted");
    } catch (e) {
      notify("error", `Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirmDelete(null);
    }
  }

  function copyMsg(content: string) {
    try { void navigator.clipboard.writeText(content); notify("success", "Copied to clipboard"); }
    catch { notify("error", "Clipboard unavailable"); }
  }

  return (
    <div className="col" style={{ height: "calc(100vh - 120px)" }}>
      <PageHeader
        kicker="Copilot"
        title={activeId ? chats.find((c) => c.id === activeId)?.title ?? "Thread" : "New thread"}
        description="Ask, follow up, and revisit threads later — answers route through your providers, free local rungs included."
      />
      {notice && <span className="small" style={{ color: "var(--warn)" }}>{notice}</span>}
      <div className="grid" style={{ gridTemplateColumns: "250px 1fr", flex: 1, minHeight: 0 }}>
        <div className="card col" style={{ overflowY: "auto", maxHeight: "100%" }}>
          <button className="primary" onClick={() => { setActiveId(null); setMessages([]); setQuestion(""); }}>New chat</button>
          <span className="kicker">History {chats.length > 0 && `(${chats.length})`}</span>
          {chats.length === 0 && <span className="small muted">Threads appear here — open one tomorrow and continue. Threads survive API restarts.</span>}
          {chats.map((c) => (
            <div key={c.id} className={c.id === activeId ? "nav-item active row" : "nav-item row"} style={{ width: "100%", justifyContent: "space-between", padding: 0 }}>
              <button
                className={c.id === activeId ? "nav-item active" : "nav-item"}
                onClick={() => setActiveId(c.id)}
                style={{ width: "100%", textAlign: "left" }}
                title={c.title}
              >
                <span className="col" style={{ gap: 2, overflow: "hidden" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                  <span className="small muted">{new Date(c.createdAt).toLocaleDateString()}</span>
                </span>
              </button>
              {confirmDelete === c.id ? (
                <span className="row" style={{ gap: 4, padding: "0 8px", flex: "none" }}>
                  <button className="ghost" style={{ color: "var(--danger)", padding: "2px 6px" }} onClick={() => void deleteChat(c.id)}>Sure?</button>
                  <button className="ghost" style={{ padding: "2px 6px" }} onClick={() => setConfirmDelete(null)}>✕</button>
                </span>
              ) : (
                <button
                  className="ghost"
                  style={{ padding: "2px 8px", flex: "none", opacity: 0.55 }}
                  title="Delete thread"
                  onClick={() => setConfirmDelete(c.id)}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="card col" style={{ minHeight: 0 }}>
          <div ref={threadRef} className="col" style={{ flex: 1, overflowY: "auto", minHeight: 0, gap: 10 }}>
            {loading && <Skeleton height="60px" />}
            {!loading && messages.length === 0 && !pending && (
              <div className="col" style={{ gap: 10, marginTop: 12 }}>
                <span className="small muted">Ask anything — follow-ups stay in this thread with full context.</span>
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  {["Compare two frameworks for real-time transcription", "Draft a follow-up email from meeting notes", "Explain vector databases like I'm a PM"].map((s) => (
                    <button key={s} className="ghost" style={{ fontSize: 12 }} onClick={() => setQuestion(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className="fade-in col"
                style={m.role === "user" ? { alignItems: "flex-end", gap: 4 } : { gap: 6 }}
              >
                {m.role === "user" ? (
                  <span className="badge accent">You</span>
                ) : (
                  <span className="row small muted" style={{ justifyContent: "space-between", width: "100%" }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="badge">{m.providerId?.includes("local") ? "free local model" : m.providerId ?? "assistant"}</span>
                      {m.providerId?.includes("local") && <span>· connect BYOK in Settings for full quality</span>}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <button className="ghost" style={{ padding: "1px 7px", fontSize: 11 }} title="Copy answer" onClick={() => copyMsg(m.content)}>⧉</button>
                    </span>
                  </span>
                )}
                <div
                  className="card"
                  style={{ fontSize: 13, lineHeight: 1.55, width: m.role === "user" ? "auto" : "100%", background: m.role === "user" ? "var(--surface-2)" : undefined, maxWidth: "100%" }}
                >
                  {m.role === "user" ? m.content : renderContent(m.content)}
                </div>
              </div>
            ))}
            {pending && (
              <div className="row" style={{ gap: 8, opacity: 0.75 }}>
                <span className="spinner" />
                <span className="small muted">Thinking…</span>
              </div>
            )}
          </div>
          <div className="row" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <input
              placeholder={activeId ? "Follow-up…" : "Ask anything…"}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void ask(question)}
              style={{ flex: 1 }}
              disabled={busy}
            />
            <button className="primary" disabled={busy || !question.trim()} onClick={() => void ask(question)}>
              {busy ? "Thinking…" : "Ask"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
