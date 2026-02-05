import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSnapshot, ShogunMessage, ThreadInfo } from "@ai-shogun/shared";
import {
  connectWs,
  createThread,
  deleteThread,
  fetchUiConfig,
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

const baseAgentDisplayNames: Record<string, string> = {
  shogun: "将軍",
  karou: "家老"
};

const defaultAshigaruDisplayNames: Record<string, string> = {
  ashigaru1: "足軽・迅速",
  ashigaru2: "足軽・軽量調査",
  ashigaru3: "足軽・標準",
  ashigaru4: "足軽・深掘り",
  ashigaru5: "足軽・重鎮",
  ashigaru6: "足軽・標準II",
  ashigaru7: "足軽・深掘りII"
};

export default function App() {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ShogunMessage[]>([]);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [ashigaruProfiles, setAshigaruProfiles] = useState<Record<string, { name: string; profile: string }>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [visibleAgents, setVisibleAgents] = useState<Set<string>>(initialVisibleAgents);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const selectionTokenRef = useRef(0);
  const pendingSelectionRef = useRef<string | null>(null);
  const creatingThreadRef = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    let stopped = false;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== null) return;
      const backoffMs = Math.min(1000 * 2 ** reconnectAttempts, 10000);
      const jitterMs = Math.floor(Math.random() * 300);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!stopped) {
          connect();
        }
      }, backoffMs + jitterMs);
    };

    const syncOnReconnect = async () => {
      try {
        const [threadList, agentList] = await Promise.all([listThreads(), listAgents()]);
        if (stopped) return;
        setThreads(threadList);
        setAgents(agentList);
        const currentId = pendingSelectionRef.current ?? selectedThreadRef.current;
        if (currentId && threadList.some((thread) => thread.id === currentId) && !pendingSelectionRef.current) {
          const token = selectionTokenRef.current;
          const threadMessages = await listMessages(currentId);
          if (stopped) return;
          if (selectionTokenRef.current !== token || pendingSelectionRef.current) {
            return;
          }
          setMessages(threadMessages);
          return;
        }
        await ensureValidSelection(threadList);
      } catch {
        // Ignore reconnect sync failures; next reconnect will retry.
      }
    };

    const connect = () => {
      ws = connectWs({
        onThreads: (data) => {
          setThreads(data);
          void ensureValidSelection(data);
        },
        onAgentStatus: (data) => setAgents(data),
        onMessage: (message) => {
          setMessages((prev) => {
            if (selectedThreadRef.current && message.threadId !== selectedThreadRef.current) return prev;
            return dedupeMessages([message, ...prev]).slice(0, 500);
          });
        },
        onOpen: () => {
          reconnectAttempts = 0;
          void syncOnReconnect();
        },
        onClose: () => {
          scheduleReconnect();
        },
        onError: () => {
          // onclose will handle reconnect.
        }
      });
    };

    const boot = async () => {
      try {
        const [threadList, agentList] = await Promise.all([listThreads(), listAgents()]);
        setThreads(threadList);
        setAgents(agentList);
        try {
          const uiConfig = await fetchUiConfig();
          setAshigaruProfiles(uiConfig.ashigaruProfiles ?? {});
        } catch {
          // Ignore config fetch failures and use defaults.
        }
        if (threadList.length > 0) {
          const active = threadList[0].id;
          await handleSelectThread(active);
        }
        connect();
      } catch (err) {
        setError(err instanceof Error ? err.message : "起動に失敗しました");
        scheduleReconnect();
      }
    };
    void boot();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      ws?.close();
    };
  }, []);

  const agentDisplayNames = useMemo(() => {
    const fromConfig: Record<string, string> = {};
    for (const [id, entry] of Object.entries(ashigaruProfiles)) {
      if (!id.startsWith("ashigaru")) continue;
      if (!entry?.name) continue;
      fromConfig[id] = `足軽・${entry.name}`;
    }
    return {
      ...defaultAshigaruDisplayNames,
      ...fromConfig,
      ...baseAgentDisplayNames
    };
  }, [ashigaruProfiles]);

  const formatAgentLabel = (agentId: string) => {
    const name = agentDisplayNames[agentId] ?? agentId;
    if (name === agentId) return agentId;
    return `${name} (${agentId})`;
  };

  const clearSelection = () => {
    selectionTokenRef.current += 1;
    pendingSelectionRef.current = null;
    setSelectedThreadId(null);
    selectedThreadRef.current = null;
    setMessages([]);
  };

  const handleSelectThread = async (threadId: string) => {
    const token = selectionTokenRef.current + 1;
    selectionTokenRef.current = token;
    pendingSelectionRef.current = threadId;
    try {
      await selectThread(threadId);
      if (selectionTokenRef.current !== token) {
        return false;
      }
      const threadMessages = await listMessages(threadId);
      if (selectionTokenRef.current !== token) {
        return false;
      }
      setSelectedThreadId(threadId);
      selectedThreadRef.current = threadId;
      setMessages(threadMessages);
      pendingSelectionRef.current = null;
      return true;
    } catch (err) {
      if (selectionTokenRef.current === token) {
        pendingSelectionRef.current = null;
        setError(err instanceof Error ? err.message : "スレッド選択に失敗しました");
      }
      return false;
    }
  };

  const ensureValidSelection = async (nextThreads: ThreadInfo[]) => {
    const currentId = pendingSelectionRef.current ?? selectedThreadRef.current;
    if (currentId && nextThreads.some((thread) => thread.id === currentId)) return;
    clearSelection();
    if (nextThreads.length > 0) {
      await handleSelectThread(nextThreads[0].id);
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

  const handleDeleteThread = async (threadId: string) => {
    if (deletingThreadId) return;
    setDeletingThreadId(threadId);
    setError(null);
    try {
      await deleteThread(threadId);
      const nextThreads = threads.filter((thread) => thread.id !== threadId);
      setThreads(nextThreads);
      await ensureValidSelection(nextThreads);
    } catch (err) {
      setError(err instanceof Error ? err.message : "スレッド削除に失敗しました");
    } finally {
      setDeletingThreadId(null);
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
          {threads.map((thread) => {
            const isActive = thread.id === selectedThreadId;
            const isDeleting = deletingThreadId === thread.id;
            return (
              <div key={thread.id} className={`thread-item ${isActive ? "active" : ""}`}>
                <button type="button" className="thread-select" onClick={() => handleSelectThread(thread.id)}>
                  <div>
                    <p className="thread-title">{thread.title}</p>
                    <p className="thread-date">{formatTime(thread.updatedAt)}</p>
                  </div>
                </button>
                <button
                  type="button"
                  className="thread-delete"
                  onClick={() => handleDeleteThread(thread.id)}
                  disabled={Boolean(deletingThreadId)}
                  aria-label={`${thread.title}を削除`}
                  title="削除"
                >
                  {isDeleting ? "削除中..." : "削除"}
                </button>
              </div>
            );
          })}
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
                {formatAgentLabel(agent.id)}
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
                    <span>{formatAgentLabel(message.from)}</span>
                    <span className="arrow">→</span>
                    <span>{formatAgentLabel(message.to)}</span>
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
                  {formatAgentLabel(agentId)}
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
                      <h3>{formatAgentLabel(agentId)}</h3>
                      <div className="tile-actions">
                        <button
                          type="button"
                          className="tile-action"
                          aria-label={`${formatAgentLabel(agentId)}の出力を拡大表示`}
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
                aria-label={`${formatAgentLabel(expandedTile.agentId)}の出力`}
                onClick={() => setExpandedAgentId(null)}
              >
                <div className="tile-overlay__card" onClick={(event) => event.stopPropagation()}>
                  <div className="tile-overlay__head">
                    <div>
                      <p className="tile-overlay__eyebrow">エージェント出力</p>
                      <h3>{formatAgentLabel(expandedTile.agentId)}</h3>
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
