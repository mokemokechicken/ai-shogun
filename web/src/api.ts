import type { AgentSnapshot, ShogunMessage, ThreadInfo, WsEvent } from "@ai-shogun/shared";

const apiBase = import.meta.env.VITE_API_URL ?? window.location.origin;

export const buildWsUrl = () => {
  if (apiBase.startsWith("https")) {
    return apiBase.replace("https", "wss") + "/ws";
  }
  return apiBase.replace("http", "ws") + "/ws";
};

export const listThreads = async (): Promise<ThreadInfo[]> => {
  const res = await fetch(`${apiBase}/api/threads`);
  if (!res.ok) {
    throw new Error("Failed to fetch threads");
  }
  const data = (await res.json()) as { threads: ThreadInfo[] };
  return data.threads;
};

export const createThread = async (title?: string): Promise<ThreadInfo> => {
  const res = await fetch(`${apiBase}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });
  if (!res.ok) {
    throw new Error("Failed to create thread");
  }
  return (await res.json()) as ThreadInfo;
};

export const selectThread = async (threadId: string): Promise<void> => {
  await fetch(`${apiBase}/api/threads/${threadId}/select`, { method: "POST" });
};

export const listMessages = async (threadId: string): Promise<ShogunMessage[]> => {
  const res = await fetch(`${apiBase}/api/threads/${threadId}/messages`);
  if (!res.ok) {
    throw new Error("Failed to fetch messages");
  }
  const data = (await res.json()) as { messages: ShogunMessage[] };
  return data.messages;
};

export const sendKingMessage = async (threadId: string, body: string, title?: string) => {
  const res = await fetch(`${apiBase}/api/threads/${threadId}/king-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, title })
  });
  if (!res.ok) {
    throw new Error("Failed to send message");
  }
};

export const stopAllAgents = async () => {
  const res = await fetch(`${apiBase}/api/stop`, { method: "POST" });
  if (!res.ok) {
    throw new Error("Failed to stop agents");
  }
};

export const listAgents = async (): Promise<AgentSnapshot[]> => {
  const res = await fetch(`${apiBase}/api/agents`);
  if (!res.ok) {
    throw new Error("Failed to fetch agents");
  }
  const data = (await res.json()) as { agents: AgentSnapshot[] };
  return data.agents;
};

export type UiConfig = {
  ashigaruProfiles?: Record<string, { name: string; profile: string }>;
};

export const fetchUiConfig = async (): Promise<UiConfig> => {
  const res = await fetch(`${apiBase}/api/config`);
  if (!res.ok) {
    throw new Error("Failed to fetch config");
  }
  return (await res.json()) as UiConfig;
};

export type WsHandlers = {
  onThreads?: (threads: ThreadInfo[]) => void;
  onMessage?: (message: ShogunMessage) => void;
  onAgentStatus?: (agents: AgentSnapshot[]) => void;
  onStop?: (status: WsEvent & { type: "stop" }) => void;
};

export const connectWs = (handlers: WsHandlers) => {
  const ws = new WebSocket(buildWsUrl());
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data) as WsEvent;
    if (data.type === "threads") {
      handlers.onThreads?.(data.threads);
    }
    if (data.type === "message") {
      handlers.onMessage?.(data.message);
    }
    if (data.type === "agent_status") {
      handlers.onAgentStatus?.(data.agents);
    }
    if (data.type === "stop") {
      handlers.onStop?.(data as WsEvent & { type: "stop" });
    }
  };
  return ws;
};
