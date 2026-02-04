import { beforeEach, describe, expect, it, vi } from "vitest";

type StartThreadOptions = Record<string, unknown>;
type ResumeThreadOptions = Record<string, unknown>;

const mockState: {
  startThreadCalls: StartThreadOptions[];
  resumeThreadCalls: ResumeThreadOptions[];
} = {
  startThreadCalls: [],
  resumeThreadCalls: []
};

vi.mock("@openai/codex-sdk", () => {
  class MockCodex {
    startThread(options: StartThreadOptions) {
      mockState.startThreadCalls.push(options);
      return {
        id: "thread-started",
        run: vi.fn(async () => ({ finalResponse: "" })),
        runStreamed: vi.fn(async () => ({
          events: (async function* () {
            // no-op
          })()
        }))
      };
    }

    resumeThread(_threadId: string, options: ResumeThreadOptions) {
      mockState.resumeThreadCalls.push(options);
      return {
        id: "thread-resumed",
        run: vi.fn(async () => ({ finalResponse: "" })),
        runStreamed: vi.fn(async () => ({
          events: (async function* () {
            // no-op
          })()
        }))
      };
    }
  }

  return { Codex: MockCodex };
});

describe("CodexProvider", () => {
  beforeEach(() => {
    mockState.startThreadCalls.length = 0;
    mockState.resumeThreadCalls.length = 0;
  });

  it("upgrades reasoning effort when minimal is requested and web search is enabled", async () => {
    const { CodexProvider } = await import("./codex.js");
    const provider = new CodexProvider({
      model: "gpt-test",
      config: {},
      env: {},
      modelReasoningEffort: "minimal" as never
    });

    await provider.createThread({ workingDirectory: "/tmp" });

    expect(mockState.startThreadCalls[0]).toMatchObject({ modelReasoningEffort: "low" });
  });

  it("does not upgrade reasoning effort for resumeThread", async () => {
    const { CodexProvider } = await import("./codex.js");
    const provider = new CodexProvider({
      model: "gpt-test",
      config: {},
      env: {},
      modelReasoningEffort: "minimal" as never
    });

    provider.resumeThread("any-thread-id");

    expect(mockState.resumeThreadCalls[0]).toMatchObject({ modelReasoningEffort: "minimal" });
  });

  it("does not upgrade reasoning effort when minimal is requested and web search is disabled", async () => {
    const { CodexProvider } = await import("./codex.js");
    const provider = new CodexProvider({
      model: "gpt-test",
      config: {},
      env: {},
      modelReasoningEffort: "minimal" as never,
      webSearchEnabled: false
    });

    await provider.createThread({ workingDirectory: "/tmp" });

    expect(mockState.startThreadCalls[0]).toMatchObject({ modelReasoningEffort: "minimal" });
  });

  it("does not force-disable web search when reasoning effort is not minimal", async () => {
    const { CodexProvider } = await import("./codex.js");
    const provider = new CodexProvider({
      model: "gpt-test",
      config: {},
      env: {},
      modelReasoningEffort: "medium" as never
    });

    await provider.createThread({ workingDirectory: "/tmp" });

    expect(mockState.startThreadCalls[0]).not.toHaveProperty("webSearchEnabled", false);
  });
});
