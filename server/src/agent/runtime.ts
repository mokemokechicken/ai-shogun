import type { AgentId, AgentSnapshot, ShogunMessage } from "@ai-shogun/shared";
import { buildSystemPrompt } from "../prompt.js";
import { writeMessageFile } from "../message/writer.js";
import type { StateStore } from "../state/store.js";
import type { LlmProvider } from "../provider/types.js";
import type { Logger } from "../logger.js";

const sendMessageRegex = /```send_message\s*([\s\S]*?)```/g;
const waitForMessageRegex = /^TOOL:waitForMessage(?:\s+timeoutMs=(\d+))?\s*$/;
const defaultWaitTimeoutMs = 60_000;
const maxLoggedOutputChars = 4000;

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

type ToolRequest =
  | { name: "getAshigaruStatus" }
  | { name: "waitForMessage"; timeoutMs?: number };

const parseToolRequest = (output: string): ToolRequest | null => {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "TOOL:getAshigaruStatus") {
      return { name: "getAshigaruStatus" };
    }
    const waitMatch = trimmed.match(waitForMessageRegex);
    if (waitMatch) {
      const timeoutMs = waitMatch[1] ? Number(waitMatch[1]) : undefined;
      if (Number.isFinite(timeoutMs) && timeoutMs !== undefined) {
        return { name: "waitForMessage", timeoutMs: Math.max(0, timeoutMs) };
      }
      return { name: "waitForMessage" };
    }
  }
  return null;
};

const shouldLogOutput = () => process.env.SHOGUN_LOG_OUTPUT === "1";

const toLoggedOutput = (value: string) => {
  if (value.length <= maxLoggedOutputChars) {
    return { output: value, truncated: false };
  }
  return { output: value.slice(0, maxLoggedOutputChars), truncated: true };
};

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
  logger?: Logger;
}

export class AgentRuntime {
  private options: AgentRuntimeOptions;
  private queue: ShogunMessage[] = [];
  private busy = false;
  private activeThreadId: string | undefined;
  private abortController: AbortController | null = null;
  private stopRequested = false;
  private messageWaiter: {
    threadId: string;
    resolve: (message: ShogunMessage | null) => void;
    timer?: NodeJS.Timeout;
  } | null = null;

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
  }

  enqueue(message: ShogunMessage) {
    if (this.tryResolveMessageWaiter(message)) return;
    this.queue.push(message);
    this.options.logger?.info("agent message enqueued", {
      agentId: this.options.agentId,
      threadId: message.threadId,
      from: message.from,
      to: message.to,
      title: message.title,
      queueSize: this.queue.length
    });
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
    this.resolveMessageWaiter(null);
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private setBusy(value: boolean) {
    this.busy = value;
    this.options.onStatusChange?.();
  }

  private resolveMessageWaiter(message: ShogunMessage | null) {
    if (!this.messageWaiter) return;
    const waiter = this.messageWaiter;
    this.messageWaiter = null;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(message);
  }

  private tryResolveMessageWaiter(message: ShogunMessage) {
    if (!this.messageWaiter) return false;
    if (message.threadId !== this.messageWaiter.threadId) return false;
    this.resolveMessageWaiter(message);
    return true;
  }

  private popQueuedMessage(threadId: string) {
    const index = this.queue.findIndex((entry) => entry.threadId === threadId);
    if (index === -1) return null;
    const [message] = this.queue.splice(index, 1);
    return message ?? null;
  }

  private async waitForMessage(threadId: string, timeoutMs?: number) {
    const queued = this.popQueuedMessage(threadId);
    if (queued) return queued;

    if (this.messageWaiter) {
      this.resolveMessageWaiter(null);
    }

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : defaultWaitTimeoutMs;

    return await new Promise<ShogunMessage | null>((resolve) => {
      const waiter = { threadId, resolve, timer: undefined as NodeJS.Timeout | undefined };
      if (effectiveTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.messageWaiter === waiter) {
            this.messageWaiter = null;
          }
          resolve(null);
        }, effectiveTimeoutMs);
      }
      this.messageWaiter = waiter;
    });
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
      this.options.logger?.info("agent session create", {
        agentId: this.options.agentId,
        threadId
      });
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
      this.options.logger?.info("agent session initializing", {
        agentId: this.options.agentId,
        threadId,
        provider: session.provider
      });
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
      this.options.logger?.info("agent message processing started", {
        agentId: this.options.agentId,
        threadId: message.threadId,
        from: message.from,
        to: message.to,
        title: message.title
      });
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
      this.options.logger?.error("agent message processing failed", {
        agentId: this.options.agentId,
        threadId: message.threadId,
        from: message.from,
        to: message.to,
        title: message.title,
        error
      });
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
      const startedAt = Date.now();
      this.options.logger?.info("provider sendMessage start", {
        agentId: this.options.agentId,
        threadId,
        loop: i + 1
      });
      const result = await this.options.provider.sendMessage({
        threadId,
        input,
        abortSignal: this.abortController?.signal
      });
      const durationMs = Date.now() - startedAt;
      output = result.outputText ?? "";
      this.options.logger?.info("provider sendMessage complete", {
        agentId: this.options.agentId,
        threadId,
        loop: i + 1,
        durationMs,
        outputLength: output.length
      });
      if (shouldLogOutput()) {
        const logged = toLoggedOutput(output);
        this.options.logger?.info("provider output", {
          agentId: this.options.agentId,
          threadId,
          loop: i + 1,
          truncated: logged.truncated,
          output: logged.output
        });
      }
      if (this.options.role === "karou") {
        const toolRequest = parseToolRequest(output);
        if (toolRequest?.name === "getAshigaruStatus") {
          const status = this.options.getAshigaruStatus?.();
          const idle = status?.idle ?? [];
          const busy = status?.busy ?? [];
          input = `TOOL_RESULT getAshigaruStatus: idle=${idle.join(",")} busy=${busy.join(",")}`;
          continue;
        }
        if (toolRequest?.name === "waitForMessage") {
          const waited = await this.waitForMessage(message.threadId, toolRequest.timeoutMs);
          const payload = waited
            ? { status: "message", message: waited }
            : { status: "timeout", timeoutMs: toolRequest.timeoutMs ?? defaultWaitTimeoutMs };
          input = `TOOL_RESULT waitForMessage: ${JSON.stringify(payload)}`;
          continue;
        }
      }
      break;
    }
    return output;
  }
}
