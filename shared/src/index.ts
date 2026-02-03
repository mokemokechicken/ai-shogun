export type Role = "king" | "shogun" | "karou" | "ashigaru";
export type AgentId = "king" | "shogun" | "karou" | `ashigaru${number}`;

export interface ThreadInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShogunMessage {
  id: string;
  threadId: string;
  from: AgentId;
  to: AgentId;
  title: string;
  body: string;
  createdAt: string;
}

export type AgentStatus = "idle" | "busy";

export interface AgentSnapshot {
  id: AgentId;
  role: Role;
  status: AgentStatus;
  queueSize: number;
  activeThreadId?: string;
}

export type WsEvent =
  | { type: "threads"; threads: ThreadInfo[] }
  | { type: "message"; message: ShogunMessage }
  | { type: "agent_status"; agents: AgentSnapshot[] }
  | { type: "stop"; status: "requested" | "completed" };
