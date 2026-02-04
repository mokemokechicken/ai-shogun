import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type Usage
} from "@openai/codex-sdk";
import type {
  LlmProvider,
  ProviderProgressUpdate,
  ProviderRunInput,
  ProviderResponse,
  ProviderThreadHandle
} from "./types.js";

interface CodexThread {
  id: string | null;
  run: (_input: string, _options?: { signal?: AbortSignal }) => Promise<{ finalResponse?: string }>;
  runStreamed: (_input: string, _options?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

const truncate = (value: string, max = 120) => {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
};

const summarizeItem = (item: ThreadItem): { label: string; detail?: string } => {
  switch (item.type) {
    case "agent_message":
      return { label: "応答生成", detail: `${item.text.length} chars` };
    case "reasoning":
      return { label: "推論", detail: truncate(item.text) };
    case "command_execution":
      return { label: "コマンド実行", detail: truncate(item.command) };
    case "file_change": {
      const changes = item.changes.map((change) => `${change.kind}:${change.path}`).join(", ");
      return { label: "ファイル変更", detail: truncate(changes) };
    }
    case "mcp_tool_call":
      return { label: "MCPツール", detail: `${item.server}:${item.tool}` };
    case "web_search":
      return { label: "Web検索", detail: truncate(item.query) };
    case "todo_list":
      return { label: "ToDo更新", detail: `${item.items.length} items` };
    case "error":
      return { label: "エラー項目", detail: truncate(item.message) };
    default:
      return { label: "項目", detail: "unknown" };
  }
};

const describeEvent = (event: ThreadEvent): ProviderProgressUpdate => {
  switch (event.type) {
    case "thread.started":
      return { label: "スレッド開始", detail: event.thread_id, kind: event.type, log: true };
    case "turn.started":
      return { label: "ターン開始", kind: event.type, log: true };
    case "turn.completed": {
      const usage = event.usage;
      const detail = usage
        ? `in:${usage.input_tokens} out:${usage.output_tokens} cache:${usage.cached_input_tokens}`
        : undefined;
      return { label: "ターン完了", detail, kind: event.type, log: true };
    }
    case "turn.failed":
      return { label: "ターン失敗", detail: event.error.message, kind: event.type, log: true };
    case "item.started": {
      const summary = summarizeItem(event.item);
      return { label: `${summary.label} 開始`, detail: summary.detail, kind: event.type, log: true };
    }
    case "item.updated": {
      const summary = summarizeItem(event.item);
      return { label: `${summary.label} 更新`, detail: summary.detail, kind: event.type, log: false };
    }
    case "item.completed": {
      const summary = summarizeItem(event.item);
      return { label: `${summary.label} 完了`, detail: summary.detail, kind: event.type, log: true };
    }
    case "error":
      return { label: "ストリームエラー", detail: event.message, kind: event.type, log: true };
  }
};

export class CodexProvider implements LlmProvider {
  kind = "codex";
  private codex: Codex;
  private threads = new Map<string, CodexThread>();
  private model: string;

  constructor(options: { model: string; config: Record<string, unknown>; env: Record<string, string> }) {
    this.model = options.model;
    const env = Object.keys(options.env).length > 0 ? options.env : undefined;
    this.codex = new Codex({ config: options.config as CodexOptions["config"], env });
  }

  async createThread(options: { workingDirectory: string; initialInput?: string }): Promise<ProviderThreadHandle> {
    const thread = this.codex.startThread({ workingDirectory: options.workingDirectory, model: this.model });
    if (options.initialInput) {
      await thread.run(options.initialInput);
    }
    const id = thread.id;
    if (!id) {
      throw new Error("Codex thread id was not returned. Provide an initialInput to initialize the thread.");
    }
    this.threads.set(id, thread as CodexThread);
    return { id };
  }

  resumeThread(threadId: string): ProviderThreadHandle {
    if (!this.threads.has(threadId)) {
      const thread = this.codex.resumeThread(threadId, { model: this.model });
      this.threads.set(threadId, thread as CodexThread);
    }
    return { id: threadId };
  }

  async sendMessage(input: ProviderRunInput): Promise<ProviderResponse> {
    const thread = this.threads.get(input.threadId) ?? (this.resumeThread(input.threadId), this.threads.get(input.threadId));
    if (!thread) {
      throw new Error(`Thread not found: ${input.threadId}`);
    }
    const { events } = await thread.runStreamed(input.input, { signal: input.abortSignal });
    const items: ThreadItem[] = [];
    let finalResponse = "";
    let usage: Usage | null = null;
    let turnFailure: string | null = null;

    for await (const event of events) {
      input.onProgress?.(describeEvent(event));
      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error.message;
        break;
      }
    }

    if (turnFailure) {
      throw new Error(turnFailure);
    }

    return {
      outputText: finalResponse,
      raw: { items, usage }
    };
  }

  async cancel(_threadId: string) {
    // Codex SDK does not expose explicit cancel; rely on AbortSignal.
  }
}
