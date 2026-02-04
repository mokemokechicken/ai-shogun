import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "@ai-shogun/shared";
import type { LlmProvider, ProviderRunInput, ProviderResponse, ProviderThreadHandle } from "../src/provider/types";
import { AgentRuntime } from "../src/agent/runtime";
import { buildAllowedRecipients } from "../src/agent/permissions";
import { StateStore } from "../src/state/store";

class SendMessageToolProvider implements LlmProvider {
  kind = "sendmessage-tool-test";
  private threadId = "sendmessage-tool-test-thread";
  private callCount = 0;
  private target: AgentId;
  toolResult: unknown | null = null;

  constructor(target: AgentId) {
    this.target = target;
  }

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

    const match = input.input.match(/TOOL_RESULT sendMessage: ([\s\S]*)/);
    if (match) {
      this.toolResult = JSON.parse(match[1]);
      return { outputText: "DONE" };
    }

    this.callCount += 1;
    if (this.callCount === 1) {
      return { outputText: `TOOL:sendMessage to=${this.target} title=report body=\"done\"` };
    }

    return { outputText: "DONE" };
  }

  async cancel(): Promise<void> {
    return;
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout");
};

describe("sendMessage permissions", () => {
  it("allows ashigaru -> ashigaru DM", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore.createThread("Test");
    await stateStore.save();

    const provider = new SendMessageToolProvider("ashigaru2");
    const runtime = new AgentRuntime({
      agentId: "ashigaru1",
      role: "ashigaru",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: buildAllowedRecipients({
        agentId: "ashigaru1",
        role: "ashigaru",
        ashigaruIds: ["ashigaru1", "ashigaru2"]
      }),
      stateStore,
      provider,
      workingDirectory: tempDir
    });

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "karou",
      to: "ashigaru1",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    });

    await waitFor(() => provider.toolResult !== null);
    expect(provider.toolResult).toMatchObject({ status: "sent", to: ["ashigaru2"] });
  });

  it("keeps ashigaru -> shogun denied", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-agent-"));
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: []
    });
    const thread = stateStore.createThread("Test");
    await stateStore.save();

    const provider = new SendMessageToolProvider("shogun");
    const runtime = new AgentRuntime({
      agentId: "ashigaru1",
      role: "ashigaru",
      baseDir: tempDir,
      historyDir: path.join(tempDir, "history"),
      allowedRecipients: buildAllowedRecipients({
        agentId: "ashigaru1",
        role: "ashigaru",
        ashigaruIds: ["ashigaru1", "ashigaru2"]
      }),
      stateStore,
      provider,
      workingDirectory: tempDir
    });

    runtime.enqueue({
      id: "msg-1",
      threadId: thread.id,
      from: "karou",
      to: "ashigaru1",
      title: "test",
      body: "do it",
      createdAt: new Date().toISOString()
    });

    await waitFor(() => provider.toolResult !== null);
    expect(provider.toolResult).toMatchObject({ status: "denied", to: ["shogun"] });
  });
});
