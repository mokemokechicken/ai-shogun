import crypto from "node:crypto";
import { readJsonFile, writeJsonFile } from "../utils.js";
import type { AgentSessionState, AppState, ThreadState } from "./types.js";
import type { AgentId } from "@ai-shogun/shared";

export class StateStore {
  private filePath: string;
  private state: AppState;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, initialState?: AppState) {
    this.filePath = filePath;
    this.state =
      initialState ??
      ({
        version: 1,
        threads: {},
        threadOrder: []
      } satisfies AppState);
  }

  static async load(filePath: string) {
    const data = await readJsonFile<AppState>(filePath);
    return new StateStore(filePath, data ?? undefined);
  }

  getState() {
    return this.state;
  }

  listThreads(): ThreadState[] {
    return this.state.threadOrder
      .map((id: string) => this.state.threads[id])
      .filter((thread: ThreadState | undefined): thread is ThreadState => Boolean(thread));
  }

  getThread(threadId: string): ThreadState | undefined {
    return this.state.threads[threadId];
  }

  createThread(title: string): ThreadState {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const thread: ThreadState = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      sessions: {}
    };
    this.state.threads[id] = thread;
    this.state.threadOrder.unshift(id);
    this.state.lastActiveThreadId = id;
    return thread;
  }

  updateThread(threadId: string, updates: Partial<Omit<ThreadState, "id" | "sessions">>) {
    const thread = this.state.threads[threadId];
    if (!thread) return;
    this.state.threads[threadId] = {
      ...thread,
      ...updates
    };
  }

  setSession(threadId: string, agentId: AgentId, session: AgentSessionState) {
    const thread = this.state.threads[threadId];
    if (!thread) return;
    thread.sessions[agentId] = session;
  }

  markSessionInitialized(threadId: string, agentId: AgentId) {
    const thread = this.state.threads[threadId];
    if (!thread) return;
    const session = thread.sessions[agentId];
    if (!session) return;
    session.initialized = true;
  }

  setLastActiveThread(threadId: string) {
    this.state.lastActiveThreadId = threadId;
  }

  getLastActiveThread(): string | undefined {
    return this.state.lastActiveThreadId;
  }

  async save() {
    const run = async () => {
      await writeJsonFile(this.filePath, this.state);
    };
    const next = this.saveChain.then(run, run);
    this.saveChain = next;
    await next;
  }
}
