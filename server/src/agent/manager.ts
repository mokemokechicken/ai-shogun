import type { AgentId, AgentSnapshot, ShogunMessage } from "@ai-shogun/shared";
import type { AppConfig } from "../config.js";
import { resolveRoleModel } from "../config.js";
import type { LlmProvider } from "../provider/types.js";
import { CodexProvider } from "../provider/codex.js";
import type { StateStore } from "../state/store.js";
import { AgentRuntime } from "./runtime.js";
import { buildSystemPrompt } from "../prompt.js";

interface AgentDefinition {
  id: AgentId;
  role: "shogun" | "karou" | "ashigaru";
  provider: LlmProvider;
}

export class AgentManager {
  private config: AppConfig;
  private stateStore: StateStore;
  private runtimes = new Map<AgentId, AgentRuntime>();
  private agents: AgentDefinition[] = [];
  private statusListeners: Array<() => void> = [];

  constructor(config: AppConfig, stateStore: StateStore) {
    this.config = config;
    this.stateStore = stateStore;
    this.buildAgents();
  }

  private buildAgents() {
    const ashigaruIds: string[] = [];
    const shogunProvider = this.createProvider("shogun");
    const karouProvider = this.createProvider("karou");
    const ashigaruProvider = this.createProvider("ashigaru");

    this.agents = [
      { id: "shogun", role: "shogun", provider: shogunProvider },
      { id: "karou", role: "karou", provider: karouProvider }
    ];

    for (let i = 1; i <= this.config.ashigaruCount; i += 1) {
      const id = `ashigaru${i}`;
      this.agents.push({ id: id as AgentId, role: "ashigaru", provider: ashigaruProvider });
      ashigaruIds.push(id);
    }

    for (const agent of this.agents) {
      const allowedRecipients = new Set<string>();
      if (agent.role === "shogun") {
        allowedRecipients.add("king");
        allowedRecipients.add("karou");
      }
      if (agent.role === "karou") {
        allowedRecipients.add("shogun");
        for (const id of ashigaruIds) {
          allowedRecipients.add(id);
        }
      }
      if (agent.role === "ashigaru") {
        allowedRecipients.add("karou");
      }
      const runtime = new AgentRuntime({
        agentId: agent.id,
        role: agent.role,
        baseDir: this.config.baseDir,
        historyDir: this.config.historyDir,
        allowedRecipients,
        stateStore: this.stateStore,
        provider: agent.provider,
        workingDirectory: this.config.rootDir,
        onStatusChange: () => this.notifyStatus(),
        getAshigaruStatus: () => this.getAshigaruStatus()
      });
      this.runtimes.set(agent.id, runtime);
    }
  }

  private createProvider(role: "shogun" | "karou" | "ashigaru") {
    const model = resolveRoleModel(this.config, role);
    if (this.config.provider === "codex") {
      return new CodexProvider({ model, config: this.config.codex.config, env: this.config.codex.env });
    }
    throw new Error(`Unsupported provider: ${this.config.provider}`);
  }

  onStatusChange(listener: () => void) {
    this.statusListeners.push(listener);
  }

  private notifyStatus() {
    for (const listener of this.statusListeners) {
      listener();
    }
  }

  async initThread(threadId: string) {
    const thread = this.stateStore.getThread(threadId);
    if (!thread) return;
    for (const agent of this.agents) {
      if (thread.sessions[agent.id]) continue;
      const systemPrompt = buildSystemPrompt({
        role: agent.role,
        agentId: agent.id,
        baseDir: this.config.baseDir,
        historyDir: this.config.historyDir
      });
      const created = await agent.provider.createThread({
        workingDirectory: this.config.rootDir,
        initialInput: `${systemPrompt}\n\n準備ができたらACKとだけ返答してください。`
      });
      this.stateStore.setSession(threadId, agent.id, {
        provider: agent.provider.kind,
        threadId: created.id,
        initialized: true
      });
    }
    await this.stateStore.save();
  }

  enqueue(to: AgentId, message: ShogunMessage) {
    const runtime = this.runtimes.get(to);
    if (!runtime) return;
    runtime.enqueue(message);
  }

  stopAll() {
    for (const runtime of this.runtimes.values()) {
      runtime.stop();
    }
    this.notifyStatus();
  }

  getStatuses(): AgentSnapshot[] {
    return Array.from(this.runtimes.values()).map((runtime) => runtime.getStatus());
  }

  getAshigaruStatus() {
    const idle: AgentId[] = [];
    const busy: AgentId[] = [];
    for (const [id, runtime] of this.runtimes.entries()) {
      if (!id.startsWith("ashigaru")) continue;
      const status = runtime.getStatus();
      if (status.status === "busy") busy.push(id);
      else idle.push(id);
    }
    return { idle, busy };
  }
}
