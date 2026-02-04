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
const maxLoggedSendMessageChars = 800;

const parseSendMessageBlock = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/);
  let to: string | undefined;
  let title: string | undefined;
  let body: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2] ?? "";
    if (key === "to") {
      to = value.trim();
      continue;
    }
    if (key === "title") {
      title = value.trim();
      continue;
    }
    if (key === "body") {
      const marker = value.trim();
      if (marker && !marker.startsWith("|")) {
        body = value;
      } else {
        const rest = lines.slice(i + 1);
        let indent = "";
        for (const restLine of rest) {
          if (!restLine.trim()) continue;
          const indentMatch = restLine.match(/^[ \t]+/);
          indent = indentMatch ? indentMatch[0] : "";
          break;
        }
        if (indent) {
          body = rest
            .map((restLine) => (restLine.startsWith(indent) ? restLine.slice(indent.length) : restLine))
            .join("\n");
        } else {
          body = rest.join("\n");
        }
      }
      break;
    }
  }

  if (to && title && typeof body === "string") {
    return { to, title, body };
  }
  return null;
};

const getAutoReplyRecipient = (role: AgentRuntimeOptions["role"]) => {
  if (role === "shogun") return "king";
  if (role === "karou") return "shogun";
  return "karou";
};

const isToolOutput = (output: string) => {
  return output
    .split("\n")
    .some((line) => line.trim().startsWith("TOOL:"));
};

const parseSendMessages = (
  output: string,
  logger?: Logger,
  meta?: { agentId?: AgentId; threadId?: string }
) => {
  const messages: Array<{ to: string; title: string; body: string }> = [];
  let match: RegExpExecArray | null;
  sendMessageRegex.lastIndex = 0;
  while ((match = sendMessageRegex.exec(output))) {
    const block = match[1];
    const parsed = parseSendMessageBlock(block);
    if (parsed) {
      messages.push(parsed);
    } else {
      const preview =
        block.length <= maxLoggedSendMessageChars ? block : block.slice(0, maxLoggedSendMessageChars);
      logger?.warn("send_message parse failed", {
        ...meta,
        truncated: block.length > maxLoggedSendMessageChars,
        output: preview
      });
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
  private statusUpdatedAt = new Date().toISOString();
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

  private touchStatus() {
    this.statusUpdatedAt = new Date().toISOString();
    this.options.onStatusChange?.();
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
    this.touchStatus();
    void this.processQueue();
  }

  getStatus(): AgentSnapshot {
    return {
      id: this.options.agentId,
      role: this.options.role,
      status: this.busy ? "busy" : "idle",
      queueSize: this.queue.length,
      activeThreadId: this.activeThreadId,
      updatedAt: this.statusUpdatedAt
    };
  }

  stop() {
    this.stopRequested = true;
    this.queue = [];
    this.resolveMessageWaiter(null);
    if (this.abortController) {
      this.abortController.abort();
    }
    this.touchStatus();
  }

  private setBusy(value: boolean) {
    this.busy = value;
    this.touchStatus();
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
    this.touchStatus();
    return true;
  }

  private popQueuedMessage(threadId: string) {
    const index = this.queue.findIndex((entry) => entry.threadId === threadId);
    if (index === -1) return null;
    const [message] = this.queue.splice(index, 1);
    this.touchStatus();
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
    const message = this.queue.shift();
    if (!message) {
      return;
    }
    this.activeThreadId = message.threadId;
    this.setBusy(true);
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
      const outbound = parseSendMessages(output, this.options.logger, {
        agentId: this.options.agentId,
        threadId: message.threadId
      });
      if (outbound.length === 0) {
        const fallbackBody = output.trim();
        if (fallbackBody && !isToolOutput(fallbackBody)) {
          const to = getAutoReplyRecipient(this.options.role);
          if (this.options.allowedRecipients.has(to)) {
            outbound.push({
              to,
              title: `auto_reply: ${message.title}`,
              body: fallbackBody
            });
            this.options.logger?.warn("auto_reply used", {
              agentId: this.options.agentId,
              threadId: message.threadId,
              to,
              title: message.title
            });
          } else {
            this.options.logger?.warn("auto_reply skipped: recipient not allowed", {
              agentId: this.options.agentId,
              threadId: message.threadId,
              to
            });
          }
        }
      }
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
