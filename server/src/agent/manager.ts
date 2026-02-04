import type { AgentId, AgentSnapshot, ShogunMessage } from "@ai-shogun/shared";
import type { AppConfig } from "../config.js";
import { resolveReasoningEffort, resolveRoleModel } from "../config.js";
import type { LlmProvider } from "../provider/types.js";
import { CodexProvider } from "../provider/codex.js";
import type { StateStore } from "../state/store.js";
import { AgentRuntime } from "./runtime.js";
import { buildAllowedRecipients } from "./permissions.js";
import { buildSystemPrompt } from "../prompt.js";
import type { Logger } from "../logger.js";

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
  private logger?: Logger;

  constructor(config: AppConfig, stateStore: StateStore, logger?: Logger) {
    this.config = config;
    this.stateStore = stateStore;
    this.logger = logger;
    this.buildAgents();
  }

  private buildAgents() {
    const ashigaruIds: AgentId[] = [];
    this.agents = [
      { id: "shogun", role: "shogun", provider: this.createProvider("shogun", "shogun") },
      { id: "karou", role: "karou", provider: this.createProvider("karou", "karou") }
    ];

    for (let i = 1; i <= this.config.ashigaruCount; i += 1) {
      const id = `ashigaru${i}`;
      this.agents.push({
        id: id as AgentId,
        role: "ashigaru",
        provider: this.createProvider("ashigaru", id as AgentId)
      });
      ashigaruIds.push(id as AgentId);
    }

    for (const agent of this.agents) {
      const allowedRecipients = buildAllowedRecipients({
        agentId: agent.id,
        role: agent.role,
        ashigaruIds
      });
      const runtime = new AgentRuntime({
        agentId: agent.id,
        role: agent.role,
        baseDir: this.config.baseDir,
        historyDir: this.config.historyDir,
        ashigaruProfiles: this.config.ashigaruProfiles,
        allowedRecipients,
        stateStore: this.stateStore,
        provider: agent.provider,
        workingDirectory: this.config.rootDir,
        onStatusChange: () => this.notifyStatus(),
        getAshigaruStatus: () => this.getAshigaruStatus(),
        interruptAgent: (to, reason) => this.interruptAgent(to, reason),
        logger: this.logger
      });
      this.runtimes.set(agent.id, runtime);
    }
  }

  private createProvider(role: "shogun" | "karou" | "ashigaru", agentId: AgentId) {
    const model = resolveRoleModel(this.config, role);
    const effort = resolveReasoningEffort(this.config, agentId, role);
    if (this.config.provider === "codex") {
      if (effort.raw && !effort.value) {
        this.logger?.warn("invalid reasoning effort; falling back to default", {
          agentId,
          role,
          value: effort.raw
        });
      }
      return new CodexProvider({
        model,
        config: this.config.codex.config,
        env: this.config.codex.env,
        modelReasoningEffort: effort.value
      });
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

  // Optional prewarm hook (not used in lazy-init flow).
  async initThread(threadId: string) {
    const thread = this.stateStore.getThread(threadId);
    if (!thread) return;
    for (const agent of this.agents) {
      if (thread.sessions[agent.id]) continue;
      this.logger?.info("initializing agent thread", { agentId: agent.id, role: agent.role, threadId });
      const systemPrompt = buildSystemPrompt({
        role: agent.role,
        agentId: agent.id,
        baseDir: this.config.baseDir,
        historyDir: this.config.historyDir,
        ashigaruProfiles: this.config.ashigaruProfiles
      });
      let created;
      try {
        created = await agent.provider.createThread({
          workingDirectory: this.config.rootDir,
          initialInput: `${systemPrompt}\n\n準備ができたらACKとだけ返答してください。`
        });
      } catch (error) {
        this.logger?.error("failed to create agent thread", {
          agentId: agent.id,
          role: agent.role,
          threadId,
          error
        });
        throw error;
      }
      this.stateStore.setSession(threadId, agent.id, {
        provider: agent.provider.kind,
        threadId: created.id,
        initialized: true
      });
    }
    await this.stateStore.save();
  }

  enqueue(to: AgentId, message: ShogunMessage): Promise<void> {
    const runtime = this.runtimes.get(to);
    if (!runtime) {
      this.logger?.warn("enqueue dropped: runtime missing", { to, threadId: message.threadId });
      return Promise.resolve();
    }
    return runtime.enqueue(message);
  }

  stopAll() {
    for (const runtime of this.runtimes.values()) {
      runtime.stop();
    }
  }

  interruptAgent(to: AgentId, reason: "stop" | "interrupt") {
    const runtime = this.runtimes.get(to);
    if (!runtime) {
      this.logger?.warn("interruptAgent dropped: runtime missing", { to, reason });
      return;
    }
    runtime.interrupt(reason);
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
