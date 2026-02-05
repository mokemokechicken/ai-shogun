import type { AgentSnapshot, ShogunMessage, ThreadInfo, WsEvent } from "@ai-shogun/shared";

const apiBase = import.meta.env.VITE_API_URL ?? window.location.origin;

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

const buildErrorMessage = async (res: Response, fallback: string) => {
  try {
    const data = (await res.json()) as ApiErrorPayload;
    if (typeof data?.error === "string" && data.error.trim()) {
      return data.error;
    }
    if (typeof data?.message === "string" && data.message.trim()) {
      return data.message;
    }
  } catch {
    // ignore parse errors
  }
  return `${fallback} (HTTP ${res.status})`;
};

const request = async (path: string, options: RequestInit, fallbackError: string) => {
  const res = await fetch(`${apiBase}${path}`, options);
  if (!res.ok) {
    throw new Error(await buildErrorMessage(res, fallbackError));
  }
  return res;
};

const requestJson = async <T>(path: string, options: RequestInit, fallbackError: string): Promise<T> => {
  const res = await request(path, options, fallbackError);
  return (await res.json()) as T;
};

const requestOk = async (path: string, options: RequestInit, fallbackError: string): Promise<void> => {
  await request(path, options, fallbackError);
};

export const buildWsUrl = () => {
  if (apiBase.startsWith("https")) {
    return apiBase.replace("https", "wss") + "/ws";
  }
  return apiBase.replace("http", "ws") + "/ws";
};

export const listThreads = async (): Promise<ThreadInfo[]> => {
  const data = await requestJson<{ threads: ThreadInfo[] }>(
    "/api/threads",
    { method: "GET" },
    "Failed to fetch threads"
  );
  return data.threads;
};

export const createThread = async (title?: string): Promise<ThreadInfo> => {
  return await requestJson<ThreadInfo>(
    "/api/threads",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    },
    "Failed to create thread"
  );
};

export const selectThread = async (threadId: string): Promise<void> => {
  await requestOk(`/api/threads/${threadId}/select`, { method: "POST" }, "Failed to select thread");
};

export const deleteThread = async (threadId: string): Promise<void> => {
  await requestOk(`/api/threads/${threadId}`, { method: "DELETE" }, "Failed to delete thread");
};

export const listMessages = async (threadId: string): Promise<ShogunMessage[]> => {
  const data = await requestJson<{ messages: ShogunMessage[] }>(
    `/api/threads/${threadId}/messages`,
    { method: "GET" },
    "Failed to fetch messages"
  );
  return data.messages;
};

export const sendKingMessage = async (threadId: string, body: string, title?: string) => {
  await requestOk(
    `/api/threads/${threadId}/king-message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, title })
    },
    "Failed to send message"
  );
};

export const stopAllAgents = async () => {
  await requestOk("/api/stop", { method: "POST" }, "Failed to stop agents");
};

export const listAgents = async (): Promise<AgentSnapshot[]> => {
  const data = await requestJson<{ agents: AgentSnapshot[] }>(
    "/api/agents",
    { method: "GET" },
    "Failed to fetch agents"
  );
  return data.agents;
};

export type UiConfig = {
  ashigaruProfiles?: Record<string, { name: string; profile: string }>;
};

export const fetchUiConfig = async (): Promise<UiConfig> => {
  return await requestJson<UiConfig>("/api/config", { method: "GET" }, "Failed to fetch config");
};

export type WsHandlers = {
  onThreads?: (threads: ThreadInfo[]) => void;
  onMessage?: (message: ShogunMessage) => void;
  onAgentStatus?: (agents: AgentSnapshot[]) => void;
  onStop?: (status: WsEvent & { type: "stop" }) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
};

export const connectWs = (handlers: WsHandlers) => {
  const ws = new WebSocket(buildWsUrl());
  ws.onopen = () => {
    handlers.onOpen?.();
  };
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
  ws.onerror = () => {
    handlers.onError?.();
  };
  ws.onclose = () => {
    handlers.onClose?.();
  };
  return ws;
};
