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

class WaitProvider implements LlmProvider {
  kind = "wait";
  private threadId = "wait-thread";
  private callCount = 0;

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
    this.callCount += 1;
    if (this.callCount === 1) {
      return { outputText: "TOOL:waitForMessage timeoutMs=500" };
    }
    const match = input.input.match(/TOOL_RESULT waitForMessage: ([\s\S]*)/);
    const body = match ? match[1] : "missing";
    const payload = JSON.stringify({ to: "shogun", title: "waited", body });
    return { outputText: `\n\n\`\`\`send_message\n${payload}\n\`\`\`` };
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

  it("waits for messages and returns tool result", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore.createThread("Test");
    await stateStore.save();

    const runtime = new AgentRuntime({
      agentId: "karou",
      role: "karou",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: new Set(["shogun"]),
      stateStore,
      provider: new WaitProvider(),
      workingDirectory: tempDir
    });

    setTimeout(() => {
      runtime.enqueue({
        id: "msg-2",
        threadId: thread.id,
        from: "ashigaru1",
        to: "karou",
        title: "result",
        body: "done",
        createdAt: new Date().toISOString()
      });
    }, 100);

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "shogun",
      to: "karou",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    });

    const outDir = path.join(tempDir, "message_to", "shogun", "from", "karou");
    await waitForFile(outDir);
    const entries = await fs.readdir(outDir);
    const fileName = entries.find((entry) => entry.endsWith(".md"));
    expect(fileName).toBeDefined();
    const content = await fs.readFile(path.join(outDir, fileName!), "utf-8");
    const payload = JSON.parse(content) as { status: string; message: { from: string; threadId: string } };
    expect(payload.status).toBe("message");
    expect(payload.message.from).toBe("ashigaru1");
    expect(payload.message.threadId).toBe(thread.id);
  });
});
