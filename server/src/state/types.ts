import type { AgentId } from "@ai-shogun/shared";

export interface AgentSessionState {
  provider: string;
  threadId: string;
  initialized: boolean;
}

export interface ThreadState {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessions: Partial<Record<AgentId, AgentSessionState>>;
}

export interface AppState {
  version: 1;
  threads: Record<string, ThreadState>;
  threadOrder: string[];
  lastActiveThreadId?: string;
}
