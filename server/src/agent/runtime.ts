import type { AgentId, AgentSnapshot, ShogunMessage } from "@ai-shogun/shared";
import { buildSystemPrompt } from "../prompt.js";
import { writeMessageFile } from "../message/writer.js";
import type { StateStore } from "../state/store.js";
import type { LlmProvider } from "../provider/types.js";

const sendMessageRegex = /```send_message\s*([\s\S]*?)```/g;

const parseSendMessages = (output: string) => {
  const messages: Array<{ to: string; title: string; body: string }> = [];
  let match: RegExpExecArray | null;
  sendMessageRegex.lastIndex = 0;
  while ((match = sendMessageRegex.exec(output))) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw) as { to: string; title: string; body: string };
      if (parsed?.to && parsed?.title && typeof parsed.body === "string") {
        messages.push({ to: parsed.to, title: parsed.title, body: parsed.body });
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return messages;
};

const hasToolRequest = (output: string) => output.split("\n").some((line) => line.trim() === "TOOL:getAshigaruStatus");

export interface AgentRuntimeOptions {
  agentId: AgentId;
  role: "shogun" | "karou" | "ashigaru";
  baseDir: string;
  historyDir: string;
  allowedRecipients: Set<string>;
  stateStore: StateStore;
  provider: LlmProvider;
  workingDirectory: string;
  onStatusChange?: () => void;
  getAshigaruStatus?: () => { idle: AgentId[]; busy: AgentId[] };
}

export class AgentRuntime {
  private options: AgentRuntimeOptions;
  private queue: ShogunMessage[] = [];
  private busy = false;
  private activeThreadId: string | undefined;
  private abortController: AbortController | null = null;
  private stopRequested = false;

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
  }

  enqueue(message: ShogunMessage) {
    this.queue.push(message);
    void this.processQueue();
  }

  getStatus(): AgentSnapshot {
    return {
      id: this.options.agentId,
      role: this.options.role,
      status: this.busy ? "busy" : "idle",
      queueSize: this.queue.length,
      activeThreadId: this.activeThreadId
    };
  }

  stop() {
    this.stopRequested = true;
    this.queue = [];
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private setBusy(value: boolean) {
    this.busy = value;
    this.options.onStatusChange?.();
  }

  private async ensureSession(threadId: string) {
    const state = this.options.stateStore.getThread(threadId);
    if (!state) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    let session = state.sessions[this.options.agentId];
    const systemPrompt = buildSystemPrompt({
      role: this.options.role,
      agentId: this.options.agentId,
      baseDir: this.options.baseDir,
      historyDir: this.options.historyDir
    });
    if (!session) {
      const created = await this.options.provider.createThread({
        workingDirectory: this.options.workingDirectory,
        initialInput: `${systemPrompt}\n\n準備ができたらACKとだけ返答してください。`
      });
      session = { provider: this.options.provider.kind, threadId: created.id, initialized: true };
      this.options.stateStore.setSession(threadId, this.options.agentId, session);
      await this.options.stateStore.save();
      return session.threadId;
    }
    if (!session.initialized) {
      await this.options.provider.sendMessage({
        threadId: session.threadId,
        input: `${systemPrompt}\n\n準備ができたらACKとだけ返答してください。`
      });
      this.options.stateStore.markSessionInitialized(threadId, this.options.agentId);
      await this.options.stateStore.save();
    }
    return session.threadId;
  }

  private async processQueue() {
    if (this.busy || this.queue.length === 0) return;
    if (this.stopRequested) {
      this.stopRequested = false;
    }
    this.setBusy(true);
    const message = this.queue.shift();
    if (!message) {
      this.setBusy(false);
      return;
    }
    this.activeThreadId = message.threadId;
    try {
      const sessionThreadId = await this.ensureSession(message.threadId);
      this.abortController = new AbortController();
      const output = await this.runWithTools(sessionThreadId, message);
      const outbound = parseSendMessages(output);
      for (const entry of outbound) {
        if (!this.options.allowedRecipients.has(entry.to)) {
          continue;
        }
        await writeMessageFile({
          baseDir: this.options.baseDir,
          threadId: message.threadId,
          from: this.options.agentId,
          to: entry.to,
          title: entry.title,
          body: entry.body
        });
      }
    } catch (error) {
      console.error(`[agent:${this.options.agentId}]`, error);
    } finally {
      this.abortController = null;
      this.activeThreadId = undefined;
      this.setBusy(false);
      const shouldContinue = !this.stopRequested;
      if (this.stopRequested) {
        this.stopRequested = false;
      }
      if (shouldContinue) {
        void this.processQueue();
      }
    }
  }

  private async runWithTools(threadId: string, message: ShogunMessage) {
    let input = `FROM: ${message.from}\nDATE: ${message.createdAt}\nTITLE: ${message.title}\n\n${message.body}`;
    let output = "";
    const maxLoops = 3;
    for (let i = 0; i < maxLoops; i += 1) {
      if (this.stopRequested) break;
      const result = await this.options.provider.sendMessage({
        threadId,
        input,
        abortSignal: this.abortController?.signal
      });
      output = result.outputText ?? "";
      if (this.options.role === "karou" && hasToolRequest(output)) {
        const status = this.options.getAshigaruStatus?.();
        const idle = status?.idle ?? [];
        const busy = status?.busy ?? [];
        input = `TOOL_RESULT getAshigaruStatus: idle=${idle.join(",")} busy=${busy.join(",")}`;
        continue;
      }
      break;
    }
    return output;
  }
}
