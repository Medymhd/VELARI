import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { PageHeader, Skeleton } from "@app/ui";

interface ChatRow { id: string; title: string; createdAt: string }
interface Msg { id: string; role: "user" | "assistant"; content: string; providerId?: string; createdAt: string }

const VERTICAL = "research";

export default function Research() {
  const { workspaceId } = useStore();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  async function loadChats() {
    if (!workspaceId) return;
    try {
      const res = await api.verticalGet<{ chats: ChatRow[] }>(VERTICAL, "/chats");
      setChats(res.chats ?? []);
    } catch { /* api down — the composer still works once it is up */ }
  }

  useEffect(() => { void loadChats(); }, [workspaceId]);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    setLoading(true);
    api.verticalGet<{ messages: Msg[] }>(VERTICAL, `/chats/${activeId}/messages`)
      .then((res) => setMessages(res.messages ?? []))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [activeId]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice(null);
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
        { question: trimmed },
      );
      setMessages((prev) => [...prev, res.userMsg, res.assistantMsg]);
      setQuestion("");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setNotice(
        raw.includes("no_provider")
          ? "No provider configured — connect a key in Settings → Providers (BYOK). The free local rung routes automatically once the API has one."
          : raw,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ height: "calc(100vh - 120px)" }}>
      <PageHeader
        kicker="Research"
        title={activeId ? chats.find((c) => c.id === activeId)?.title ?? "Thread" : "New research"}
        description="Ask, follow up, and revisit threads later — answers route through your providers, free local rungs included."
      />
      {notice && <span className="small" style={{ color: "var(--warn)" }}>{notice}</span>}
      <div className="grid" style={{ gridTemplateColumns: "240px 1fr", flex: 1, minHeight: 0 }}>
        <div className="card col" style={{ overflowY: "auto", maxHeight: "100%" }}>
          <button className="primary" onClick={() => { setActiveId(null); setMessages([]); setQuestion(""); }}>New chat</button>
          <span className="kicker">History</span>
          {chats.length === 0 && <span className="small muted">Threads appear here — open one tomorrow and continue.</span>}
          {chats.map((c) => (
            <button
              key={c.id}
              className={c.id === activeId ? "nav-item active" : "nav-item"}
              onClick={() => setActiveId(c.id)}
              style={{ width: "100%" }}
            >
              <span className="col" style={{ gap: 2, overflow: "hidden" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                <span className="small muted">{new Date(c.createdAt).toLocaleDateString()}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="card col" style={{ minHeight: 0 }}>
          <div ref={threadRef} className="col" style={{ flex: 1, overflowY: "auto", minHeight: 0, gap: 10 }}>
            {loading && <Skeleton height="60px" />}
            {!loading && messages.length === 0 && (
              <span className="small muted">Ask a research question — follow-ups stay in this thread with full context.</span>
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
                    <span className="badge">{m.providerId?.includes("local") ? "free local model" : m.providerId ?? "assistant"}</span>
                    {m.providerId?.includes("local") && <span>· connect BYOK in Settings for full quality</span>}
                  </span>
                )}
                <div
                  className="card"
                  style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", width: m.role === "user" ? "auto" : "100%", background: m.role === "user" ? "var(--surface-2)" : undefined }}
                >
                  {m.content}
                </div>
              </div>
            ))}
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
