import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startRestartWatcher } from "../src/restart/watcher";

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

describe("restart watcher", () => {
  it("moves request to history and triggers restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-restart-"));
    const baseDir = tempDir;
    const restartDir = path.join(baseDir, "tmp", "restart");
    const requestDir = path.join(restartDir, "requests");
    await fs.mkdir(requestDir, { recursive: true });

    const received: string[] = [];
    const watcher = await startRestartWatcher(baseDir, {
      onRestart: async (request) => {
        received.push(request.reason ?? "");
      }
    });

    await new Promise<void>((resolve) => watcher.on("ready", () => resolve()));

    const fileName = "restart-1.json";
    const filePath = path.join(requestDir, fileName);
    await fs.writeFile(filePath, JSON.stringify({ reason: "test" }), "utf-8");

    await waitFor(() => received.length > 0);
    expect(received[0]).toBe("test");

    const historyPath = path.join(restartDir, "history", fileName);
    await waitFor(async () => {
      try {
        await fs.stat(historyPath);
        return true;
      } catch {
        return false;
      }
    });

    await watcher.close();
  });

  it("retries processing files after restart", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shogun-restart-"));
    const baseDir = tempDir;
    const restartDir = path.join(baseDir, "tmp", "restart");
    const requestDir = path.join(restartDir, "requests");
    await fs.mkdir(requestDir, { recursive: true });

    const fileName = "restart-2.json";
    const filePath = path.join(requestDir, fileName);

    let attempts = 0;
    const handler = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boom");
      }
    };

    const watcher1 = await startRestartWatcher(baseDir, { onRestart: handler });
    await new Promise<void>((resolve) => watcher1.on("ready", () => resolve()));

    await fs.writeFile(filePath, JSON.stringify({ reason: "retry" }), "utf-8");
    await waitFor(() => attempts === 1);

    const processingPath = path.join(restartDir, "processing", fileName);
    const processingStat = await fs.stat(processingPath);
    expect(processingStat.isFile()).toBe(true);

    await watcher1.close();

    const watcher2 = await startRestartWatcher(baseDir, { onRestart: handler });
    await new Promise<void>((resolve) => watcher2.on("ready", () => resolve()));

    await waitFor(() => attempts === 2);

    const historyPath = path.join(restartDir, "history", fileName);
    await waitFor(async () => {
      try {
        await fs.stat(historyPath);
        return true;
      } catch {
        return false;
      }
    });

    await watcher2.close();
  });
});
