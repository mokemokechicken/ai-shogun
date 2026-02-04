import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSnapshot, ShogunMessage, ThreadInfo } from "@ai-shogun/shared";
import {
  connectWs,
  createThread,
  listAgents,
  listMessages,
  listThreads,
  selectThread,
  sendKingMessage,
  stopAllAgents
} from "./api";

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

const dedupeMessages = (items: ShogunMessage[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
};

const sortAgentIds = (ids: string[]) => {
  const baseOrder = new Map<string, number>([
    ["shogun", 0],
    ["karou", 1]
  ]);
  const score = (id: string) => {
    const base = baseOrder.get(id);
    if (base !== undefined) return base;
    const match = id.match(/^ashigaru(\d+)$/);
    if (match) {
      const num = Number(match[1]);
      if (Number.isFinite(num)) return 2 + Math.max(0, num - 1);
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return [...ids].sort((a, b) => {
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
};

const initialVisibleAgents = new Set<string>(["shogun", "karou", "ashigaru1", "ashigaru2", "ashigaru3"]);

export default function App() {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ShogunMessage[]>([]);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [visibleAgents, setVisibleAgents] = useState<Set<string>>(initialVisibleAgents);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const creatingThreadRef = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    const boot = async () => {
      try {
        const [threadList, agentList] = await Promise.all([listThreads(), listAgents()]);
        setThreads(threadList);
        setAgents(agentList);
        if (threadList.length > 0) {
          const active = threadList[0].id;
          await handleSelectThread(active);
        }
        ws = connectWs({
          onThreads: (data) => setThreads(data),
          onAgentStatus: (data) => setAgents(data),
          onMessage: (message) => {
            setMessages((prev) => {
              if (selectedThreadRef.current && message.threadId !== selectedThreadRef.current) return prev;
              return dedupeMessages([message, ...prev]).slice(0, 500);
            });
          }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "起動に失敗しました");
      }
    };
    void boot();
    return () => {
      ws?.close();
    };
  }, []);

  const handleSelectThread = async (threadId: string) => {
    try {
      await selectThread(threadId);
      const threadMessages = await listMessages(threadId);
      setSelectedThreadId(threadId);
      selectedThreadRef.current = threadId;
      setMessages(threadMessages);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "スレッド選択に失敗しました");
      return false;
    }
  };

  const handleCreateThread = async () => {
    if (creatingThreadRef.current) return;
    creatingThreadRef.current = true;
    setCreatingThread(true);
    setError(null);
    let newThread: ThreadInfo | null = null;
    try {
      const title = `Thread ${threads.length + 1}`;
      newThread = await createThread(title);
      setThreads((prev) => {
        if (prev.some((thread) => thread.id === newThread!.id)) {
          return prev;
        }
        return [newThread!, ...prev];
      });
      await handleSelectThread(newThread.id);
    } catch (err) {
      if (newThread) {
        setError(err instanceof Error ? err.message : "スレッド選択に失敗しました");
      } else {
        setError(err instanceof Error ? err.message : "スレッド作成に失敗しました");
      }
    } finally {
      creatingThreadRef.current = false;
      setCreatingThread(false);
    }
  };

  const handleSend = async () => {
    if (!draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      let threadId = selectedThreadId;
      if (!threadId) {
        const title = `Thread ${threads.length + 1}`;
        const newThread = await createThread(title);
        setThreads((prev) => {
          if (prev.some((thread) => thread.id === newThread.id)) {
            return prev;
          }
          return [newThread, ...prev];
        });
        const selected = await handleSelectThread(newThread.id);
        if (!selected) return;
        threadId = newThread.id;
      }
      await sendKingMessage(threadId, draft.trim());
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (selectedThreadRef.current === threadId) {
        const threadMessages = await listMessages(threadId);
        setMessages(threadMessages);
      }
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    setError(null);
    try {
      await stopAllAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "停止に失敗しました");
    }
  };

  const visibleAgentList = useMemo(() => {
    const ids = agents.map((agent) => agent.id);
    const unique = Array.from(new Set(ids));
    return sortAgentIds(unique);
  }, [agents]);

  const agentById = useMemo(() => {
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  const threadTitleById = useMemo(() => {
    return new Map(threads.map((thread) => [thread.id, thread.title]));
  }, [threads]);

  const messagesByAgent = useMemo(() => {
    const byAgent = new Map<string, ShogunMessage>();
    for (const message of messages) {
      if (!byAgent.has(message.from)) {
        byAgent.set(message.from, message);
      }
    }
    return byAgent;
  }, [messages]);

  const agentTiles = useMemo(() => {
    return visibleAgentList
      .filter((agentId) => visibleAgents.has(agentId))
      .map((agentId) => {
        const status = agentById.get(agentId);
        const message = messagesByAgent.get(agentId);
        return { agentId, status, message };
      });
  }, [visibleAgentList, visibleAgents, agentById, messagesByAgent]);

  const expandedTile = useMemo(() => {
    if (!expandedAgentId) return null;
    return agentTiles.find((tile) => tile.agentId === expandedAgentId) ?? null;
  }, [agentTiles, expandedAgentId]);

  const formatActiveThread = (threadId?: string) => {
    if (!threadId) return "待機中";
    if (threadId === selectedThreadId) return "このスレッド";
    return threadTitleById.get(threadId) ?? threadId;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <p className="brand__title">AI Shogun</p>
          <p className="brand__subtitle">Command Center</p>
        </div>
        <button className="primary" type="button" onClick={handleCreateThread} disabled={creatingThread}>
          {creatingThread ? "作成中..." : "+ 新規スレッド"}
        </button>
        <div className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={`thread-item ${thread.id === selectedThreadId ? "active" : ""}`}
              onClick={() => handleSelectThread(thread.id)}
            >
              <div>
                <p className="thread-title">{thread.title}</p>
                <p className="thread-date">{formatTime(thread.updatedAt)}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="danger" type="button" onClick={handleStop}>
            全員停止
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="header">
          <div>
            <h1>王の指揮所</h1>
            <p>指示は将軍へ送信されます。</p>
          </div>
          <div className="status-row">
            {agents.map((agent) => (
              <span key={agent.id} className={`status-pill ${agent.status}`}>
                {agent.id}
              </span>
            ))}
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        <section className="command-panel">
          <div className="command-header">
            <h2>指示入力</h2>
            <span className="hint">宛先: shogun</span>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="将軍への指示を入力..."
          />
          <div className="command-actions">
            <button className="primary" type="button" disabled={sending} onClick={handleSend}>
              {sending ? "送信中..." : "送信"}
            </button>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel messages">
            <div className="panel-header">
              <h2>メッセージログ</h2>
              <p className="hint">FROM / TO / TIME</p>
            </div>
            <div className="message-list">
              {messages.map((message) => (
                <div key={message.id} className="message-card">
                  <div className="message-meta">
                    <span>{message.from}</span>
                    <span className="arrow">→</span>
                    <span>{message.to}</span>
                    <span className="time">{formatTime(message.createdAt)}</span>
                  </div>
                  <p className="message-title">{message.title}</p>
                  <pre className="message-body">{message.body}</pre>
                </div>
              ))}
            </div>
          </div>

          <div className="panel agents">
            <div className="panel-header">
              <h2>エージェント出力</h2>
              <p className="hint">表示する役割を選択</p>
            </div>
            <div className="agent-toggle">
              {visibleAgentList.map((agentId) => (
                <button
                  key={agentId}
                  type="button"
                  className={`toggle ${visibleAgents.has(agentId) ? "active" : ""}`}
                  onClick={() => {
                    setVisibleAgents((prev) => {
                      const next = new Set(prev);
                      if (next.has(agentId)) {
                        next.delete(agentId);
                      } else {
                        next.add(agentId);
                      }
                      return next;
                    });
                  }}
                >
                  {agentId}
                </button>
              ))}
            </div>
            <div className="tile-grid">
              {agentTiles.map(({ agentId, status, message }) => {
                const stateLabel = status?.status === "busy" ? "稼働中" : "待機中";
                const queueSize = status?.queueSize ?? 0;
                const statusUpdatedAt = status?.updatedAt ? formatTime(status.updatedAt) : "-";
                const latestActivity = status?.activityLog?.[0];
                return (
                  <article key={agentId} className={`agent-tile ${status?.status ?? "idle"}`}>
                    <div className="tile-head">
                      <h3>{agentId}</h3>
                      <div className="tile-actions">
                        <button
                          type="button"
                          className="tile-action"
                          aria-label={`${agentId}の出力を拡大表示`}
                          title="拡大表示"
                          onClick={() => setExpandedAgentId(agentId)}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                            <path
                              d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <span className={`status-badge ${status?.status ?? "idle"}`}>{stateLabel}</span>
                      </div>
                    </div>
                    <div className="tile-meta">
                      <span>キュー: {queueSize}</span>
                      <span>作業: {formatActiveThread(status?.activeThreadId)}</span>
                      <span>進行中: {status?.activity ?? "-"}</span>
                      <span>更新: {statusUpdatedAt}</span>
                      <span>出力(選択中): {message ? formatTime(message.createdAt) : "-"}</span>
                    </div>
                    {message ? (
                      <>
                        <p className="tile-title">{message.title}</p>
                        <pre className="tile-body">{message.body}</pre>
                      </>
                    ) : latestActivity ? (
                      <div className="tile-activity">
                        <span className="tile-activity__time">{formatTime(latestActivity.ts)}</span>
                        <span className="tile-activity__label">{latestActivity.label}</span>
                        {latestActivity.detail && (
                          <span className="tile-activity__detail">{latestActivity.detail}</span>
                        )}
                      </div>
                    ) : (
                      <p className="tile-placeholder">選択中スレッドの出力はまだありません。</p>
                    )}
                  </article>
                );
              })}
            </div>
            {expandedTile && (
              <div
                className="tile-overlay"
                role="dialog"
                aria-modal="true"
                aria-label={`${expandedTile.agentId}の出力`}
                onClick={() => setExpandedAgentId(null)}
              >
                <div className="tile-overlay__card" onClick={(event) => event.stopPropagation()}>
                  <div className="tile-overlay__head">
                    <div>
                      <p className="tile-overlay__eyebrow">エージェント出力</p>
                      <h3>{expandedTile.agentId}</h3>
                    </div>
                    <button
                      type="button"
                      className="tile-action tile-action--close"
                      aria-label="拡大表示を閉じる"
                      title="閉じる"
                      onClick={() => setExpandedAgentId(null)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="tile-meta">
                    <span>状態: {expandedTile.status?.status === "busy" ? "稼働中" : "待機中"}</span>
                    <span>キュー: {expandedTile.status?.queueSize ?? 0}</span>
                    <span>作業: {formatActiveThread(expandedTile.status?.activeThreadId)}</span>
                    <span>進行中: {expandedTile.status?.activity ?? "-"}</span>
                    <span>更新: {expandedTile.status?.updatedAt ? formatTime(expandedTile.status.updatedAt) : "-"}</span>
                    <span>
                      出力(選択中):{" "}
                      {expandedTile.message ? formatTime(expandedTile.message.createdAt) : "-"}
                    </span>
                  </div>
                  <div className="activity-log">
                    <p className="activity-log__title">進行履歴</p>
                    {expandedTile.status?.activityLog?.length ? (
                      <div className="activity-log__list">
                        {expandedTile.status.activityLog.map((entry, index) => (
                          <div key={`${entry.ts}-${index}`} className="activity-log__row">
                            <span className="activity-log__time">{formatTime(entry.ts)}</span>
                            <span className="activity-log__label">{entry.label}</span>
                            {entry.detail && (
                              <span className="activity-log__detail">{entry.detail}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="activity-log__empty">履歴はまだありません。</p>
                    )}
                  </div>
                  {expandedTile.message ? (
                    <>
                      <p className="tile-title">{expandedTile.message.title}</p>
                      <pre className="tile-body tile-body--full">{expandedTile.message.body}</pre>
                    </>
                  ) : (
                    <p className="tile-placeholder">選択中スレッドの出力はまだありません。</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
