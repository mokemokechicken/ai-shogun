import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmProvider, ProviderRunInput, ProviderResponse, ProviderThreadHandle } from "../src/provider/types";
import { AgentRuntime } from "../src/agent/runtime";
import { StateStore } from "../src/state/store";

class FakeProvider implements LlmProvider {
  kind = "fake";
  private threadId = "fake-thread";

  async createThread(options?: { workingDirectory: string; initialInput?: string }): Promise<ProviderThreadHandle> {
    if (options?.initialInput) {
      await this.sendMessage({ threadId: this.threadId, input: options.initialInput });
    }
    return { id: this.threadId };
  }

  resumeThread(threadId: string): ProviderThreadHandle {
    this.threadId = threadId;
    return { id: threadId };
  }

  async sendMessage(input: ProviderRunInput): Promise<ProviderResponse> {
    if (input.input.includes("ACK")) {
      return { outputText: "ACK" };
    }
    return {
      outputText: `\n\n\`\`\`send_message\n{"to":"karou","title":"report","body":"done"}\n\`\`\``
    };
  }

  async cancel(): Promise<void> {
    return;
  }
}

const waitForFile = async (dirPath: string, timeoutMs = 1500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const entries = await fs.readdir(dirPath);
      if (entries.some((entry) => entry.endsWith(".md"))) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout");
};

describe("agent runtime", () => {
  it("writes outgoing message files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore.createThread("Test");
    await stateStore.save();

    const runtime = new AgentRuntime({
      agentId: "shogun",
      role: "shogun",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: new Set(["karou"]),
      stateStore,
      provider: new FakeProvider(),
      workingDirectory: tempDir
    });

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "king",
      to: "shogun",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    });

    const outDir = path.join(tempDir, "message_to", "karou", "from", "shogun");
    await waitForFile(outDir);
    const entries = await fs.readdir(outDir);
    expect(entries.some((entry) => entry.endsWith(".md"))).toBe(true);
  });
});
