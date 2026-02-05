import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmProvider, ProviderRunInput, ProviderResponse, ProviderThreadHandle } from "../src/provider/types";
import { AgentRuntime } from "../src/agent/runtime";
import { StateStore } from "../src/state/store";
import { HistoryStore } from "../src/history/store";

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
    if (input.input.includes("TOOL_RESULT sendMessage")) {
      return { outputText: "" };
    }
    return {
      outputText: `TOOL:sendMessage to=karou title=report body="done"`
    };
  }

  async cancel(): Promise<void> {
    return;
  }
}

class JsonToolProvider implements LlmProvider {
  kind = "json-tool";
  private threadId = "json-tool-thread";

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
    if (input.input.includes("TOOL_RESULT sendMessage")) {
      return { outputText: "DONE" };
    }
    return {
      outputText: `TOOL sendMessage {"to":["karou"],"title":"report","body":"done"}`
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
    if (input.input.includes("TOOL_RESULT sendMessage")) {
      return { outputText: "" };
    }
    this.callCount += 1;
    if (this.callCount === 1) {
      return { outputText: "TOOL:waitForMessage timeoutMs=500" };
    }
    const match = input.input.match(/TOOL_RESULT waitForMessage: ([\s\S]*)/);
    const body = match ? match[1] : "missing";
    return {
      outputText: `TOOL:sendMessage to=shogun title=waited body='${body}'`
    };
  }

  async cancel(): Promise<void> {
    return;
  }
}

class ShogunWaitProvider implements LlmProvider {
  kind = "shogun-wait";
  private threadId = "shogun-wait-thread";
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
    if (input.input.includes("TOOL_RESULT sendMessage")) {
      return { outputText: "" };
    }
    this.callCount += 1;
    if (this.callCount === 1) {
      return { outputText: "TOOL:waitForMessage timeoutMs=500" };
    }
    const match = input.input.match(/TOOL_RESULT waitForMessage: ([\s\S]*)/);
    const body = match ? match[1] : "missing";
    return {
      outputText: `TOOL:sendMessage to=king title=waited body='${body}'`
    };
  }

  async cancel(): Promise<void> {
    return;
  }
}

class AutoWrapProvider implements LlmProvider {
  kind = "auto-wrap";
  private threadId = "auto-wrap-thread";

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
    return { outputText: "ashigaru1" };
  }

  async cancel(): Promise<void> {
    return;
  }
}

class ToolOnlyProvider implements LlmProvider {
  kind = "tool-only";
  private threadId = "tool-only-thread";

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
    return { outputText: "TOOL:waitForMessage timeoutMs=0" };
  }

  async cancel(): Promise<void> {
    return;
  }
}

class DurableWaitProvider implements LlmProvider {
  kind = "durable-wait";
  private threadId = "durable-wait-thread";
  private stage = new Map<string, "fresh" | "waiting">();

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
    const stage = this.stage.get(input.threadId) ?? "fresh";
    if (input.input.includes("TOOL_RESULT waitForMessage")) {
      if (stage !== "waiting") {
        throw new Error(`unexpected wait tool result in stage ${stage}`);
      }
      return {
        outputText: `TOOL:sendMessage to=shogun title=waited body='ok'`
      };
    }
    if (input.input.includes("TOOL_RESULT sendMessage")) {
      return { outputText: "" };
    }
    if (stage !== "fresh") {
      throw new Error(`unexpected initial message in stage ${stage}`);
    }
    this.stage.set(input.threadId, "waiting");
    return { outputText: "TOOL:waitForMessage timeoutMs=0" };
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

const waitForEntry = async (
  dirPath: string,
  matcher: (entry: string) => boolean,
  timeoutMs = 1500
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const entries = await fs.readdir(dirPath);
      const match = entries.find(matcher);
      if (match) return match;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout");
};

const waitForPath = async (filePath: string, timeoutMs = 1500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.stat(filePath);
      return;
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

  it("writes outgoing message files with JSON tool syntax", async () => {
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
      provider: new JsonToolProvider(),
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
    const fileName = entries.find((entry) => entry.endsWith(".md"));
    expect(fileName).toBeDefined();
    const content = await fs.readFile(path.join(outDir, fileName!), "utf-8");
    expect(content).toBe("done");
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
    const fileName = await waitForEntry(outDir, (entry) => entry.includes("__waited"));
    const content = await fs.readFile(path.join(outDir, fileName), "utf-8");
    const payload = JSON.parse(content) as { status: string; message: { from: string; threadId: string } };
    expect(payload.status).toBe("message");
    expect(payload.message.from).toBe("ashigaru1");
    expect(payload.message.threadId).toBe(thread.id);
  });

  it("shogun can wait for messages and return tool result", async () => {
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
      allowedRecipients: new Set(["king"]),
      stateStore,
      provider: new ShogunWaitProvider(),
      workingDirectory: tempDir
    });

    setTimeout(() => {
      runtime.enqueue({
        id: "msg-2",
        threadId: thread.id,
        from: "king",
        to: "shogun",
        title: "follow-up",
        body: "done",
        createdAt: new Date().toISOString()
      });
    }, 100);

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "king",
      to: "shogun",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    });

    const outDir = path.join(tempDir, "message_to", "king", "from", "shogun");
    const fileName = await waitForEntry(outDir, (entry) => entry.includes("__waited"));
    const content = await fs.readFile(path.join(outDir, fileName), "utf-8");
    const payload = JSON.parse(content) as { status: string; message: { from: string; threadId: string } };
    expect(payload.status).toBe("message");
    expect(payload.message.from).toBe("king");
    expect(payload.message.threadId).toBe(thread.id);
  });

  it("auto-replies when output has no tool calls", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore.createThread("Test");
    await stateStore.save();

    const runtime = new AgentRuntime({
      agentId: "ashigaru1",
      role: "ashigaru",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: new Set(["karou"]),
      stateStore,
      provider: new AutoWrapProvider(),
      workingDirectory: tempDir
    });

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "karou",
      to: "ashigaru1",
      title: "rollcall",
      body: "reply with your name only",
      createdAt: new Date().toISOString()
    });

    const outDir = path.join(tempDir, "message_to", "karou", "from", "ashigaru1");
    await waitForFile(outDir);
    const entries = await fs.readdir(outDir);
    const fileName = entries.find((entry) => entry.endsWith(".md"));
    expect(fileName).toBeDefined();
    const content = await fs.readFile(path.join(outDir, fileName!), "utf-8");
    expect(content.trim()).toBe("ashigaru1");
  });

  it("does not auto-wrap tool output", async () => {
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
      provider: new ToolOnlyProvider(),
      workingDirectory: tempDir
    });

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
    await new Promise((resolve) => setTimeout(resolve, 400));
    const entries = await fs.readdir(outDir).catch(() => []);
    expect(entries.some((entry) => entry.endsWith(".md"))).toBe(false);
  });

  it("restores wait state after restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const statePath = path.join(tempDir, "state.json");
    const stateStore1 = new StateStore(statePath, {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore1.createThread("Test");
    await stateStore1.save();
    const historyStore = new HistoryStore(path.join(tempDir, "history"));

    const provider = new DurableWaitProvider();
    const initialMessage: ShogunMessage = {
      id: "msg-1",
      threadId: thread.id,
      from: "shogun",
      to: "karou",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    };
    await historyStore.appendMessage(thread.id, initialMessage);

    const runtime1 = new AgentRuntime({
      agentId: "karou",
      role: "karou",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: new Set(["shogun"]),
      stateStore: stateStore1,
      provider,
      workingDirectory: tempDir
    });

    void runtime1.enqueue(initialMessage);

    const waitPath = path.join(tempDir, "waits", "pending", `${thread.id}__karou.json`);
    await waitForPath(waitPath);

    const stateStore2 = await StateStore.load(statePath);
    const runtime2 = new AgentRuntime({
      agentId: "karou",
      role: "karou",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: new Set(["shogun"]),
      stateStore: stateStore2,
      provider,
      workingDirectory: tempDir
    });

    await runtime2.enqueue({
      id: "msg-2",
      threadId: thread.id,
      from: "ashigaru1",
      to: "karou",
      title: "follow-up",
      body: "done",
      createdAt: new Date().toISOString()
    });

    await runtime2.resumePendingWaits(historyStore);

    const outDir = path.join(tempDir, "message_to", "shogun", "from", "karou");
    await waitForFile(outDir);
    const entries = await fs.readdir(outDir);
    expect(entries.some((entry) => entry.includes("__waited.md"))).toBe(true);

    const waitExistsAfter = await fs
      .stat(waitPath)
      .then(() => true)
      .catch(() => false);
    expect(waitExistsAfter).toBe(false);
  });
});
