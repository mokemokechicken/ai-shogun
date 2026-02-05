import type { AgentId, AgentSnapshot, ShogunMessage } from "@ai-shogun/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { buildSystemPrompt } from "../prompt.js";
import { writeMessageFile } from "../message/writer.js";
import type { HistoryStore } from "../history/store.js";
import type { StateStore } from "../state/store.js";
import type { LlmProvider, ProviderProgressUpdate, ProviderResponse } from "../provider/types.js";
import type { Logger } from "../logger.js";
import { WaitStore, type WaitRecord } from "../wait/store.js";

const waitForMessageRegex = /^TOOL:waitForMessage(?:\s+timeoutMs=(\d+))?\s*$/;
const interruptAgentRegex = /^TOOL:interruptAgent(?:\s+(.*))?\s*$/;
const sendMessageToolRegex = /^TOOL:sendMessage(?:\s+(.*))?\s*$/;
const jsonToolPrefix = "TOOL ";
const toolArgRegex = /(\w+)=(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+))/g;
const maxToolBodyBytes = 10 * 1024;

const unescapeToolValue = (value: string) => {
  return value
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'");
};

const parseToolArgs = (raw: string | undefined) => {
  const args: Record<string, string> = {};
  if (!raw) return args;
  let match: RegExpExecArray | null;
  toolArgRegex.lastIndex = 0;
  while ((match = toolArgRegex.exec(raw))) {
    const key = match[1];
    const quoted = match[2] ?? match[3] ?? null;
    const bare = match[4] ?? null;
    const value = quoted !== null ? unescapeToolValue(quoted) : bare ?? "";
    args[key] = value;
  }
  return args;
};

const isDirectSubordinate = (role: AgentRuntimeOptions["role"], target: AgentId) => {
  if (role === "shogun") return target === "karou";
  if (role === "karou") return target.startsWith("ashigaru");
  return false;
};

const parseRecipients = (value: string): AgentId[] => {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) as AgentId[];
};

const parseRecipientsValue = (value: unknown): AgentId[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : String(entry)))
      .map((entry) => entry.trim())
      .filter(Boolean) as AgentId[];
  }
  if (typeof value === "string") {
    return parseRecipients(value);
  }
  return [];
};

const resolveBodyFilePath = (
  baseDir: string,
  workingDirectory: string,
  agentId: AgentId,
  bodyFile: string
) => {
  const allowedRoot = path.resolve(baseDir, "tmp", agentId);
  const normalizedRoot = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  const candidates = bodyFile
    ? [
        path.isAbsolute(bodyFile) ? path.resolve(bodyFile) : path.resolve(workingDirectory, bodyFile),
        path.isAbsolute(bodyFile) ? path.resolve(bodyFile) : path.resolve(baseDir, bodyFile)
      ]
    : [];
  for (const resolved of candidates) {
    if (resolved.startsWith(normalizedRoot)) {
      return { path: resolved };
    }
  }
  return { error: `bodyFile must be under ${allowedRoot}` };
};
const defaultWaitTimeoutMs = 60_000;
const maxLoggedOutputChars = 4000;
const activityLogLimit = 40;

const getAutoReplyRecipient = (role: AgentRuntimeOptions["role"]) => {
  if (role === "shogun") return "king";
  if (role === "karou") return "shogun";
  return "karou";
};

const isToolOutput = (output: string) => {
  return output
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("TOOL:") || trimmed.startsWith(jsonToolPrefix);
    });
};

const parseJsonToolLine = (trimmed: string): ToolRequest | null => {
  if (!trimmed.startsWith(jsonToolPrefix) || trimmed.startsWith("TOOL:")) {
    return null;
  }
  const rest = trimmed.slice(jsonToolPrefix.length).trim();
  if (!rest) return null;
  const firstSpace = rest.indexOf(" ");
  const toolName = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const payloadRaw = firstSpace === -1 ? "" : rest.slice(firstSpace).trim();
  if (!payloadRaw) {
    if (toolName === "getAshigaruStatus") {
      return { name: "getAshigaruStatus" };
    }
    if (toolName === "waitForMessage") {
      return { name: "waitForMessage" };
    }
    return null;
  }
  if (!payloadRaw.startsWith("{")) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Record<string, unknown>;
  if (toolName === "getAshigaruStatus") {
    return { name: "getAshigaruStatus" };
  }
  if (toolName === "waitForMessage") {
    const rawTimeout = data.timeoutMs;
    if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout)) {
      return { name: "waitForMessage", timeoutMs: Math.max(0, rawTimeout) };
    }
    return { name: "waitForMessage" };
  }
  if (toolName === "interruptAgent") {
    const to = parseRecipientsValue(data.to);
    if (to.length === 0) return null;
    return {
      name: "interruptAgent",
      to,
      title: typeof data.title === "string" ? data.title : undefined,
      body: typeof data.body === "string" ? data.body : undefined
    };
  }
  if (toolName === "sendMessage") {
    const to = parseRecipientsValue(data.to);
    if (to.length === 0) return null;
    return {
      name: "sendMessage",
      to,
      title: typeof data.title === "string" ? data.title : undefined,
      body: typeof data.body === "string" ? data.body : undefined,
      bodyFile: typeof data.bodyFile === "string" ? data.bodyFile : undefined
    };
  }
  return null;
};

const formatMessageBatchInput = (messages: ShogunMessage[]) => {
  if (messages.length === 1) {
    const message = messages[0];
    return `FROM: ${message.from}\nDATE: ${message.createdAt}\nTITLE: ${message.title}\n\n${message.body}`;
  }
  const lines: string[] = [`BATCH_START count=${messages.length}`];
  messages.forEach((message, index) => {
    const idx = index + 1;
    lines.push(`--- MESSAGE ${idx}/${messages.length} START ---`);
    lines.push(`FROM: ${message.from}`);
    lines.push(`DATE: ${message.createdAt}`);
    lines.push(`TITLE: ${message.title}`);
    lines.push("BODY:");
    lines.push(message.body ?? "");
    lines.push(`--- MESSAGE ${idx}/${messages.length} END ---`);
  });
  lines.push("BATCH_END");
  return lines.join("\n");
};

type ToolRequest =
  | { name: "getAshigaruStatus" }
  | { name: "waitForMessage"; timeoutMs?: number }
  | { name: "interruptAgent"; to: AgentId[]; title?: string; body?: string }
  | { name: "sendMessage"; to: AgentId[]; title?: string; body?: string; bodyFile?: string };

const parseToolRequests = (output: string): ToolRequest[] => {
  const requests: ToolRequest[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsonRequest = parseJsonToolLine(trimmed);
    if (jsonRequest) {
      requests.push(jsonRequest);
      continue;
    }
    if (trimmed === "TOOL:getAshigaruStatus") {
      requests.push({ name: "getAshigaruStatus" });
      continue;
    }
    const interruptMatch = trimmed.match(interruptAgentRegex);
    if (interruptMatch) {
      const args = parseToolArgs(interruptMatch[1]);
      const toRaw = args.to?.trim();
      if (toRaw) {
        const to = parseRecipients(toRaw);
        if (to.length === 0) continue;
        requests.push({
          name: "interruptAgent",
          to,
          title: args.title,
          body: args.body
        });
      }
      continue;
    }
    const waitMatch = trimmed.match(waitForMessageRegex);
    if (waitMatch) {
      const timeoutMs = waitMatch[1] ? Number(waitMatch[1]) : undefined;
      if (Number.isFinite(timeoutMs) && timeoutMs !== undefined) {
        requests.push({ name: "waitForMessage", timeoutMs: Math.max(0, timeoutMs) });
      } else {
        requests.push({ name: "waitForMessage" });
      }
      continue;
    }
    const sendMatch = trimmed.match(sendMessageToolRegex);
    if (sendMatch) {
      const args = parseToolArgs(sendMatch[1]);
      const toRaw = args.to?.trim();
      if (!toRaw) {
        continue;
      }
      const to = parseRecipients(toRaw);
      if (to.length === 0) continue;
      requests.push({
        name: "sendMessage",
        to,
        title: args.title,
        body: args.body,
        bodyFile: args.bodyFile
      });
      continue;
    }
  }
  return requests;
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
  ashigaruProfiles?: Record<string, { name: string; profile: string }>;
  allowedRecipients: Set<string>;
  stateStore: StateStore;
  provider: LlmProvider;
  workingDirectory: string;
  onStatusChange?: () => void;
  getAshigaruStatus?: () => { idle: AgentId[]; busy: AgentId[] };
  interruptAgent?: (to: AgentId, reason: "stop" | "interrupt") => void;
  logger?: Logger;
}

export class AgentRuntime {
  private options: AgentRuntimeOptions;
  private queue: ShogunMessage[] = [];
  private busy = false;
  private activeThreadId: string | undefined;
  private statusUpdatedAt = new Date().toISOString();
  private activity: { label: string; updatedAt: string } | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private activityLog: Array<{ ts: string; label: string; detail?: string }> = [];
  private abortController: AbortController | null = null;
  private abortReason: "stop" | "interrupt" | null = null;
  private stopRequested = false;
  private waitStore: WaitStore;
  private messageWaiter: {
    threadId: string;
    resolve: (message: ShogunMessage | null) => void;
    timer?: NodeJS.Timeout;
  } | null = null;
  private completionWaiters = new Map<string, Array<{ resolve: () => void; reject: (_error: unknown) => void }>>();

  constructor(options: AgentRuntimeOptions) {
    this.options = options;
    this.waitStore = new WaitStore(options.baseDir);
  }

  async resumePendingWaits(historyStore: HistoryStore) {
    const records = await this.waitStore.list();
    const resumable = records.filter(
      (record) =>
        record.version === 1 &&
        record.agentId === this.options.agentId &&
        (record.status === "pending" || record.status === "received" || record.status === "timeout")
    );
    if (resumable.length === 0) return;

    const messageCache = new Map<string, ShogunMessage[]>();

    for (const record of resumable) {
      const thread = this.options.stateStore.getThread(record.threadId);
      if (!thread) {
        this.options.logger?.warn("resume wait skipped: thread missing", {
          agentId: this.options.agentId,
          threadId: record.threadId,
          messageId: record.messageId
        });
        continue;
      }

      let messages = messageCache.get(record.threadId);
      if (!messages) {
        messages = await historyStore.listMessages(record.threadId);
        messageCache.set(record.threadId, messages);
      }

      const message = messages.find((entry) => entry.id === record.messageId);
      if (!message) {
        this.options.logger?.warn("resume wait skipped: message missing", {
          agentId: this.options.agentId,
          threadId: record.threadId,
          messageId: record.messageId
        });
        continue;
      }

      if (this.queue.some((entry) => entry.id === message.id)) {
        continue;
      }

      this.options.logger?.info("resuming wait message", {
        agentId: this.options.agentId,
        threadId: record.threadId,
        messageId: record.messageId,
        status: record.status
      });

      void this.enqueue(message).catch((error) => {
        this.options.logger?.error("resume wait enqueue failed", {
          agentId: this.options.agentId,
          threadId: record.threadId,
          messageId: record.messageId,
          error
        });
      });
    }
  }

  private touchStatus() {
    this.statusUpdatedAt = new Date().toISOString();
    this.options.onStatusChange?.();
  }

  enqueue = async (message: ShogunMessage): Promise<void> => {
    const waitKey = WaitStore.buildKey(message.threadId, this.options.agentId);
    const waitRecord = await this.waitStore.load(waitKey);
    if (
      waitRecord &&
      waitRecord.version === 1 &&
      waitRecord.status === "pending" &&
      waitRecord.threadId === message.threadId &&
      waitRecord.agentId === this.options.agentId &&
      waitRecord.messageId !== message.id
    ) {
      const now = new Date().toISOString();
      const updated: WaitRecord = {
        ...waitRecord,
        status: "received",
        updatedAt: now,
        receivedAt: now,
        receivedMessage: message
      };
      await this.waitStore.upsert(updated);
      if (this.tryResolveMessageWaiter(message)) {
        return;
      }
      this.options.logger?.info("message stored for wait resume", {
        agentId: this.options.agentId,
        threadId: message.threadId,
        messageId: message.id,
        waitKey
      });
      this.touchStatus();
      return;
    }

    if (this.tryResolveMessageWaiter(message)) {
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve, reject) => {
      const waiters = this.completionWaiters.get(message.id) ?? [];
      waiters.push({ resolve, reject });
      this.completionWaiters.set(message.id, waiters);
    });
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
    return promise;
  };

  getStatus(): AgentSnapshot {
    return {
      id: this.options.agentId,
      role: this.options.role,
      status: this.busy ? "busy" : "idle",
      queueSize: this.queue.length,
      activeThreadId: this.activeThreadId,
      updatedAt: this.statusUpdatedAt,
      activity: this.activity?.label,
      activityUpdatedAt: this.activity?.updatedAt,
      activityLog: this.activityLog.length > 0 ? [...this.activityLog] : undefined
    };
  }

  stop() {
    this.stopRequested = true;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) {
      this.rejectCompletionWaiters(message.id, new Error("agent stopped"));
    }
    this.resolveMessageWaiter(null);
    if (this.abortController) {
      this.abortReason = "stop";
      this.abortController.abort();
    }
    this.clearActivityTimer();
    this.setActivity(null);
    this.touchStatus();
  }

  private setBusy(value: boolean) {
    this.busy = value;
    if (!value) {
      this.clearActivityTimer();
      this.setActivity(null);
    }
    this.touchStatus();
  }

  private setActivity(label: string | null) {
    if (label) {
      this.activity = { label, updatedAt: new Date().toISOString() };
    } else {
      this.activity = null;
    }
    this.touchStatus();
  }

  private recordActivity(label: string, detail?: string) {
    const ts = new Date().toISOString();
    const combined = detail ? `${label}: ${detail}` : label;
    this.activity = { label: combined, updatedAt: ts };
    this.activityLog = [{ ts, label, detail }, ...this.activityLog].slice(0, activityLogLimit);
    this.touchStatus();
  }

  private handleProgress(update: ProviderProgressUpdate) {
    const combined = update.detail ? `${update.label}: ${update.detail}` : update.label;
    if (update.log === false) {
      this.setActivity(combined);
      return;
    }
    this.recordActivity(update.label, update.detail);
  }

  private async resolveSendMessageBody(body?: string, bodyFile?: string) {
    const inline = body ?? "";
    if (inline.trim()) {
      return { body: inline, source: "inline" as const };
    }
    if (!bodyFile) {
      return { error: "body or bodyFile is required" };
    }
    const resolved = resolveBodyFilePath(
      this.options.baseDir,
      this.options.workingDirectory,
      this.options.agentId,
      bodyFile
    );
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    try {
      const stat = await fs.stat(resolved.path);
      if (!stat.isFile()) {
        return { error: "bodyFile is not a file" };
      }
      if (stat.size > maxToolBodyBytes) {
        return { error: `bodyFile exceeds ${maxToolBodyBytes} bytes` };
      }
      const raw = await fs.readFile(resolved.path, "utf-8");
      return { body: raw, source: "file" as const, bodyFile: resolved.path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { error: "bodyFile not found" };
      }
      return { error: "bodyFile read failed" };
    }
  }

  private clearActivityTimer() {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private startActivityHeartbeat(label: string, startedAt: number, intervalMs = 2000) {
    this.clearActivityTimer();
    const update = () => {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      this.setActivity(`${label} (${elapsedSec}s)`);
    };
    update();
    this.activityTimer = setInterval(update, intervalMs);
    return () => {
      this.clearActivityTimer();
    };
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

  private drainQueuedMessages(threadId: string) {
    if (this.queue.length === 0) return [] as ShogunMessage[];
    const drained: ShogunMessage[] = [];
    const remaining: ShogunMessage[] = [];
    for (const entry of this.queue) {
      if (entry.threadId === threadId) {
        drained.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    if (drained.length > 0) {
      this.queue = remaining;
      this.touchStatus();
    }
    return drained;
  }

  private async waitForMessage(threadId: string, timeoutMs?: number) {
    const waitKey = WaitStore.buildKey(threadId, this.options.agentId);
    const waitRecord = await this.waitStore.load(waitKey);
    if (waitRecord?.status === "received" && waitRecord.receivedMessage) {
      return waitRecord.receivedMessage;
    }
    if (waitRecord?.status === "timeout") {
      return null;
    }

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
          void (async () => {
            const current = await this.waitStore.load(waitKey);
            if (!current || current.status !== "pending") {
              return;
            }
            const now = new Date().toISOString();
            await this.waitStore.upsert({
              ...current,
              status: "timeout",
              updatedAt: now
            });
          })();
          resolve(null);
        }, effectiveTimeoutMs);
      }
      this.messageWaiter = waiter;
    });
  }

  interrupt(reason: "stop" | "interrupt") {
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) {
      this.rejectCompletionWaiters(message.id, new Error(`agent interrupted: ${reason}`));
    }
    this.resolveMessageWaiter(null);
    if (this.abortController) {
      this.abortReason = reason;
      this.abortController.abort();
    }
    this.recordActivity(reason === "interrupt" ? "割り込み停止" : "停止");
    this.touchStatus();
  }

  private resolveCompletionWaiters(messageId: string) {
    const waiters = this.completionWaiters.get(messageId);
    if (!waiters) return;
    this.completionWaiters.delete(messageId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectCompletionWaiters(messageId: string, error: unknown) {
    const waiters = this.completionWaiters.get(messageId);
    if (!waiters) return;
    this.completionWaiters.delete(messageId);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
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
      historyDir: this.options.historyDir,
      ashigaruProfiles: this.options.ashigaruProfiles
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
    const batch = [message, ...this.drainQueuedMessages(message.threadId)];
    this.activeThreadId = message.threadId;
    this.setBusy(true);
    if (batch.length > 1) {
      this.setActivity(`指示処理開始: ${message.title} 他${batch.length - 1}件`);
    } else {
      this.setActivity(`指示処理開始: ${message.title}`);
    }
    let processingError: unknown = null;
    try {
      this.options.logger?.info("agent message processing started", {
        agentId: this.options.agentId,
        threadId: message.threadId,
        from: message.from,
        to: message.to,
        title: message.title,
        batchSize: batch.length
      });
      const sessionThreadId = await this.ensureSession(message.threadId);
      this.abortController = new AbortController();
      const output = await this.runWithTools(sessionThreadId, batch);
      if (this.abortReason) {
        throw new Error(`agent aborted: ${this.abortReason}`);
      }
      const fallbackBody = output.trim();
      if (fallbackBody && !isToolOutput(fallbackBody)) {
        const to = getAutoReplyRecipient(this.options.role);
        if (this.options.allowedRecipients.has(to)) {
          await writeMessageFile({
            baseDir: this.options.baseDir,
            threadId: message.threadId,
            from: this.options.agentId,
            to,
            title: `auto_reply: ${message.title}${batch.length > 1 ? ` (+${batch.length - 1})` : ""}`,
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
    } catch (error) {
      processingError = error;
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
      if (!processingError) {
        const waitKey = WaitStore.buildKey(message.threadId, this.options.agentId);
        const record = await this.waitStore.load(waitKey);
        if (record?.version === 1 && record.messageId === message.id) {
          await this.waitStore.remove(waitKey);
        }
      }
      this.abortController = null;
      this.activeThreadId = undefined;
      this.setBusy(false);
      this.abortReason = null;
      for (const entry of batch) {
        if (processingError) {
          this.rejectCompletionWaiters(entry.id, processingError);
        } else {
          this.resolveCompletionWaiters(entry.id);
        }
      }
      const shouldContinue = !this.stopRequested;
      if (this.stopRequested) {
        this.stopRequested = false;
      }
      if (shouldContinue) {
        void this.processQueue();
      }
    }
  }

  private async runWithTools(threadId: string, messages: ShogunMessage[]) {
    const primary = messages[0];
    let input = formatMessageBatchInput(messages);
    let output = "";
    const waitLimit = 10;
    let waitRemaining = waitLimit;
    let maxLoops = 3;

    const waitKey = WaitStore.buildKey(primary.threadId, this.options.agentId);
    const existingWait = await this.waitStore.load(waitKey);
    if (
      existingWait &&
      existingWait.version === 1 &&
      existingWait.threadId === primary.threadId &&
      existingWait.agentId === this.options.agentId &&
      existingWait.messageId === primary.id &&
      (existingWait.status === "pending" || existingWait.status === "received" || existingWait.status === "timeout")
    ) {
      this.options.logger?.info("resuming wait state", {
        agentId: this.options.agentId,
        threadId: primary.threadId,
        messageId: primary.id,
        status: existingWait.status,
        waitKey
      });
      const timeoutMs = existingWait.timeoutMs;
      const waited =
        existingWait.status === "received" && existingWait.receivedMessage
          ? existingWait.receivedMessage
          : existingWait.status === "timeout"
            ? null
            : await this.waitForMessage(primary.threadId, timeoutMs);
      const payload = waited ? { status: "message", message: waited } : { status: "timeout", timeoutMs };
      input = `TOOL_RESULT waitForMessage: ${JSON.stringify(payload)}`;
    }

    for (let i = 0; i < maxLoops; i += 1) {
      if (this.stopRequested) break;
      const startedAt = Date.now();
      const stopHeartbeat = this.startActivityHeartbeat(`LLM応答待ち L${i + 1}/${maxLoops}`, startedAt);
      this.options.logger?.info("provider sendMessage start", {
        agentId: this.options.agentId,
        threadId,
        loop: i + 1
      });
      let result: ProviderResponse;
      try {
        result = await this.options.provider.sendMessage({
          threadId,
          input,
          abortSignal: this.abortController?.signal,
          onProgress: (update) => this.handleProgress(update)
        });
      } catch (error) {
        if (this.abortReason) {
          this.options.logger?.info("agent run aborted", {
            agentId: this.options.agentId,
            threadId,
            reason: this.abortReason
          });
          this.setActivity(this.abortReason === "interrupt" ? "割り込み停止" : "停止");
          break;
        }
        throw error;
      } finally {
        stopHeartbeat();
      }
      const durationMs = Date.now() - startedAt;
      output = result.outputText ?? "";
      this.setActivity(`LLM応答受信 (${output.length} chars)`);
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
      const toolRequests = parseToolRequests(output);
      if (toolRequests.length > 0) {
        const results: Array<Record<string, unknown>> = [];
        let waitEncountered = false;
        for (const toolRequest of toolRequests) {
          if (waitEncountered) {
            this.options.logger?.warn("tool ignored: tool after waitForMessage", {
              agentId: this.options.agentId,
              threadId,
              tool: toolRequest.name
            });
            continue;
          }
          if (toolRequest.name === "getAshigaruStatus") {
            if (this.options.role !== "karou") {
              this.options.logger?.warn("tool ignored: getAshigaruStatus not allowed", {
                agentId: this.options.agentId,
                threadId
              });
              results.push({ tool: "getAshigaruStatus", status: "ignored" });
              continue;
            }
            this.setActivity("アシガル状況取得中");
            const status = this.options.getAshigaruStatus?.();
            const idle = status?.idle ?? [];
            const busy = status?.busy ?? [];
            this.setActivity("アシガル状況取得完了");
            results.push({ tool: "getAshigaruStatus", status: "ok", idle, busy });
            continue;
          }
          if (toolRequest.name === "waitForMessage") {
            if (this.options.role !== "karou" && this.options.role !== "shogun") {
              this.options.logger?.warn("tool ignored: waitForMessage not allowed", {
                agentId: this.options.agentId,
                threadId
              });
              results.push({ tool: "waitForMessage", status: "ignored" });
              continue;
            }
            if (waitRemaining <= 0) {
              const payload = {
                status: "timeout",
                timeoutMs: 0,
                remainingWaits: 0,
                limitReached: true
              };
              this.setActivity("待機上限到達 (残り待機0回)");
              this.options.logger?.warn("waitForMessage limit reached", {
                agentId: this.options.agentId,
                threadId,
                waitLimit
              });
              results.push({ tool: "waitForMessage", ...payload });
              if (i + 1 >= maxLoops) {
                maxLoops += 1;
              }
              waitEncountered = true;
              continue;
            }
            waitRemaining -= 1;
            const waitStartedAt = Date.now();
            const stopWaitHeartbeat = this.startActivityHeartbeat("メッセージ待機中", waitStartedAt);
            const timeoutMs = toolRequest.timeoutMs ?? defaultWaitTimeoutMs;
            const now = new Date().toISOString();
            const record: WaitRecord = {
              version: 1,
              key: waitKey,
              status: "pending",
              threadId: primary.threadId,
              agentId: this.options.agentId,
              providerThreadId: threadId,
              timeoutMs,
              messageId: primary.id,
              messageFrom: primary.from,
              messageTo: primary.to,
              messageTitle: primary.title,
              messageCreatedAt: primary.createdAt,
              createdAt: existingWait?.createdAt ?? now,
              updatedAt: now,
              receivedAt: existingWait?.receivedAt,
              receivedMessage: existingWait?.receivedMessage
            };
            await this.waitStore.upsert(record);

            const waited = await this.waitForMessage(primary.threadId, timeoutMs);
            stopWaitHeartbeat();
            const finishedAt = new Date().toISOString();
            if (waited) {
              await this.waitStore.upsert({
                ...record,
                status: "received",
                updatedAt: finishedAt,
                receivedAt: finishedAt,
                receivedMessage: waited
              });
            } else {
              await this.waitStore.upsert({
                ...record,
                status: "timeout",
                updatedAt: finishedAt
              });
            }

            const payload = waited
              ? { status: "message", message: waited, remainingWaits: waitRemaining }
              : { status: "timeout", timeoutMs, remainingWaits: waitRemaining };
            this.setActivity(
              waited ? `メッセージ受信 (残り待機${waitRemaining}回)` : `待機タイムアウト (残り待機${waitRemaining}回)`
            );
            maxLoops += 1;
            results.push({ tool: "waitForMessage", ...payload });
            this.options.logger?.info("waitForMessage remaining updated", {
              agentId: this.options.agentId,
              threadId,
              remaining: waitRemaining,
              waitLimit
            });
            waitEncountered = true;
            continue;
          }
          if (toolRequest.name === "interruptAgent") {
            const rawBody = toolRequest.body ?? "";
            const body = rawBody.trim();
            const title = toolRequest.title?.trim() || `interrupt: ${primary.title}`;
            const hasBody = body.length > 0;
            const recipients = Array.from(new Set(toolRequest.to));
            const allowed = recipients.filter(
              (target) => this.options.allowedRecipients.has(target) && isDirectSubordinate(this.options.role, target)
            );
            const denied = recipients.filter((target) => !allowed.includes(target));
            if (allowed.length === 0) {
              results.push({ tool: "interruptAgent", status: "denied", to: denied, title });
              continue;
            }
            for (const target of allowed) {
              this.options.interruptAgent?.(target, hasBody ? "interrupt" : "stop");
              if (hasBody) {
                await writeMessageFile({
                  baseDir: this.options.baseDir,
                  threadId: primary.threadId,
                  from: this.options.agentId,
                  to: target,
                  title,
                  body
                });
              }
            }
            this.setActivity(hasBody ? "割り込み指示送信" : "停止指示送信");
            results.push({
              tool: "interruptAgent",
              status: hasBody ? "interrupted" : "stopped",
              to: allowed,
              denied
            });
          }
          if (toolRequest.name === "sendMessage") {
            const title = toolRequest.title?.trim() || primary.title;
            const recipients = Array.from(new Set(toolRequest.to));
            const denied = recipients.filter((entry) => !this.options.allowedRecipients.has(entry));
            const allowed = recipients.filter((entry) => this.options.allowedRecipients.has(entry));
            if (allowed.length === 0) {
              results.push({ tool: "sendMessage", status: "denied", to: denied, title });
              continue;
            }
            const resolvedBody = await this.resolveSendMessageBody(toolRequest.body, toolRequest.bodyFile);
            if ("error" in resolvedBody) {
              results.push({
                tool: "sendMessage",
                status: "error",
                error: resolvedBody.error,
                to: allowed,
                title
              });
              continue;
            }
            for (const to of allowed) {
              await writeMessageFile({
                baseDir: this.options.baseDir,
                threadId: primary.threadId,
                from: this.options.agentId,
                to,
                title,
                body: resolvedBody.body
              });
            }
            this.setActivity("メッセージ送信");
            results.push({
              tool: "sendMessage",
              status: "sent",
              to: allowed,
              denied,
              title,
              bodySource: resolvedBody.source,
              bodyFile: resolvedBody.source === "file" ? resolvedBody.bodyFile : undefined
            });
          }
        }

        if (toolRequests.length === 1) {
          const single = toolRequests[0];
          const singleResult = results[0] ?? null;
          if (single?.name === "getAshigaruStatus" && singleResult?.status === "ok") {
            const idle = (singleResult.idle as AgentId[] | undefined) ?? [];
            const busy = (singleResult.busy as AgentId[] | undefined) ?? [];
            input = `TOOL_RESULT getAshigaruStatus: idle=${idle.join(",")} busy=${busy.join(",")}`;
            continue;
          }
          if (single?.name === "waitForMessage" && singleResult) {
            const payload =
              singleResult.status === "message"
                ? {
                    status: "message",
                    message: singleResult.message,
                    remainingWaits: singleResult.remainingWaits
                  }
                : {
                    status: "timeout",
                    timeoutMs: singleResult.timeoutMs ?? defaultWaitTimeoutMs,
                    remainingWaits: singleResult.remainingWaits,
                    limitReached: singleResult.limitReached
                  };
            input = `TOOL_RESULT waitForMessage: ${JSON.stringify(payload)}`;
            continue;
          }
          if (single?.name === "interruptAgent" && singleResult) {
            input = `TOOL_RESULT interruptAgent: ${JSON.stringify({
              status: singleResult.status,
              to: singleResult.to,
              denied: singleResult.denied
            })}`;
            continue;
          }
          if (single?.name === "sendMessage" && singleResult) {
            input = `TOOL_RESULT sendMessage: ${JSON.stringify(singleResult)}`;
            continue;
          }
        }

        input = `TOOL_RESULT batch: ${JSON.stringify(results)}`;
        this.setActivity("ツール実行完了");
        continue;
      }
      break;
    }
    return output;
  }
}
