import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMessageWatcher } from "../src/message/watcher";
import { HistoryStore } from "../src/history/store";
import { StateStore } from "../src/state/store";

process.env.SHOGUN_WATCH_POLLING = "1";

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 1500) => {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = async () => {
      try {
        const ok = await predicate();
        if (ok) return resolve();
      } catch {
        // ignore
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
};

describe("message watcher", () => {
  it("moves message to history and emits", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-"));
    const baseDir = tempDir;
    const historyDir = path.join(tempDir, "history");
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: [],
      lastActiveThreadId: "thread123"
    });
    await stateStore.save();

    const historyStore = new HistoryStore(historyDir);
    const received: string[] = [];

    const messageDir = path.join(baseDir, "message_to", "shogun", "from", "king");
    await fs.mkdir(messageDir, { recursive: true });

    const watcher = await startMessageWatcher(baseDir, historyDir, historyStore, stateStore, {
      onMessage: async (message) => {
        received.push(message.id);
        expect(message.threadId).toBe("thread123");
        expect(message.title).toBe("hello");
      }
    });

    await new Promise<void>((resolve) => {
      watcher.on("ready", () => resolve());
    });

    const fileName = "thread123__2026-02-03T00-00-00Z__hello.md";
    const filePath = path.join(messageDir, fileName);
    await fs.writeFile(filePath, "test body", "utf-8");

    await waitFor(() => received.length > 0);

    const historyPath = path.join(historyDir, "thread123", "message_to", "shogun", "from", "king", fileName);
    await waitFor(async () => {
      try {
        await fs.stat(historyPath);
        return true;
      } catch {
        return false;
      }
    });
    const stat = await fs.stat(historyPath);
    expect(stat.isFile()).toBe(true);

    await watcher.close();
  });

  it("retries processing files after restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-"));
    const baseDir = tempDir;
    const historyDir = path.join(tempDir, "history");
    const stateStore = new StateStore(path.join(tempDir, "state.json"), {
      version: 1,
      threads: {},
      threadOrder: [],
      lastActiveThreadId: "thread123"
    });
    await stateStore.save();

    const historyStore = new HistoryStore(historyDir);

    const messageDir = path.join(baseDir, "message_to", "shogun", "from", "king");
    await fs.mkdir(messageDir, { recursive: true });
    const fileName = "thread123__2026-02-03T00-00-00Z__hello.md";
    const filePath = path.join(messageDir, fileName);

    let attempts = 0;
    const handler = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boom");
      }
    };

    const watcher1 = await startMessageWatcher(baseDir, historyDir, historyStore, stateStore, {
      onMessage: handler
    });
    await new Promise<void>((resolve) => watcher1.on("ready", () => resolve()));

    await fs.writeFile(filePath, "test body", "utf-8");
    await waitFor(() => attempts === 1);

    const processingPath = path.join(baseDir, "message_processing", "shogun", "from", "king", fileName);
    const processingStat = await fs.stat(processingPath);
    expect(processingStat.isFile()).toBe(true);

    const historyLogPath = path.join(historyDir, "thread123", "messages.jsonl");
    const logRaw = await fs.readFile(historyLogPath, "utf-8");
    expect(logRaw.trim().split("\n")).toHaveLength(1);

    await watcher1.close();

    const watcher2 = await startMessageWatcher(baseDir, historyDir, historyStore, stateStore, {
      onMessage: handler
    });
    await new Promise<void>((resolve) => watcher2.on("ready", () => resolve()));

    await waitFor(() => attempts === 2);

    const historyPath = path.join(historyDir, "thread123", "message_to", "shogun", "from", "king", fileName);
    await waitFor(async () => {
      try {
        await fs.stat(historyPath);
        return true;
      } catch {
        return false;
      }
    });
    const historyStat = await fs.stat(historyPath);
    expect(historyStat.isFile()).toBe(true);

    const logRaw2 = await fs.readFile(historyLogPath, "utf-8");
    expect(logRaw2.trim().split("\n")).toHaveLength(1);

    await watcher2.close();
  });
});
