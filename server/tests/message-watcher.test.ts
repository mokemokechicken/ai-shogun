import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMessageWatcher } from "../src/message/watcher";
import { HistoryStore } from "../src/history/store";
import { StateStore } from "../src/state/store";

process.env.SHOGUN_WATCH_POLLING = "1";

const waitFor = async (predicate: () => boolean, timeoutMs = 1500) => {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
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

    const watcher = startMessageWatcher(baseDir, historyDir, historyStore, stateStore, {
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
    const stat = await fs.stat(historyPath);
    expect(stat.isFile()).toBe(true);

    await watcher.close();
  });
});
