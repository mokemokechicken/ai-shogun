import { Codex, type CodexOptions } from "@openai/codex-sdk";
import type { LlmProvider, ProviderRunInput, ProviderResponse, ProviderThreadHandle } from "./types.js";

interface CodexThread {
  id: string | null;
  run: (_input: string, _options?: { signal?: AbortSignal }) => Promise<{ finalResponse?: string }>;
}

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
    const result = await thread.run(input.input, { signal: input.abortSignal });
    return {
      outputText: result.finalResponse ?? "",
      raw: result
    };
  }

  async cancel(_threadId: string) {
    // Codex SDK does not expose explicit cancel; rely on AbortSignal.
  }
}
