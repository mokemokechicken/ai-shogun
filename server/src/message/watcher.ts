import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import type { ShogunMessage } from "@ai-shogun/shared";
import { ensureDir } from "../utils.js";
import type { HistoryStore } from "../history/store.js";
import type { StateStore } from "../state/store.js";
import type { Logger } from "../logger.js";
import { MessageLedger } from "./ledger.js";

export interface MessageWatcherHandlers {
  onMessage: (_message: ShogunMessage) => Promise<void> | void;
}

const isNoEntryError = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

type QueueDir = "message_to" | "message_processing";

const parsePath = (filePath: string, baseDir: string) => {
  const relative = path.relative(baseDir, filePath);
  const parts = relative.split(path.sep);
  if (parts.length < 5) return null;
  const [queueDir, to, fromLabel, from, fileName] = parts;
  if ((queueDir !== "message_to" && queueDir !== "message_processing") || fromLabel !== "from") return null;
  if (!fileName.endsWith(".md")) return null;
  return { queueDir: queueDir as QueueDir, to, from, baseName: fileName, stem: path.parse(fileName).name };
};

const parseTitle = (fileName: string) => {
  const parts = fileName.split("__");
  if (parts.length >= 3) {
    return { threadId: parts[0] ?? null, title: parts.slice(2).join("__") };
  }
  if (parts.length === 2) {
    return { threadId: parts[0] ?? null, title: parts[1] ?? fileName };
  }
  return { threadId: null, title: fileName };
};

const toIdempotencyKey = (baseDir: string, filePath: string) => {
  const relative = path.relative(baseDir, filePath);
  const parts = relative.split(path.sep);
  if (parts[0] === "message_processing") {
    parts[0] = "message_to";
  }
  return parts.join("/");
};

const buildProcessingPath = (baseDir: string, to: string, from: string, baseName: string) =>
  path.join(baseDir, "message_processing", to, "from", from, baseName);

const buildHistoryPath = (historyDir: string, threadId: string, to: string, from: string, stem: string) =>
  path.join(historyDir, threadId, "message_to", to, "from", from, `${stem}.md`);

export const startMessageWatcher = async (
  baseDir: string,
  historyDir: string,
  historyStore: HistoryStore,
  stateStore: StateStore,
  handlers: MessageWatcherHandlers,
  logger?: Logger
) => {
  const watchPaths = [path.join(baseDir, "message_to"), path.join(baseDir, "message_processing")];
  await ensureDir(watchPaths[0]);
  await ensureDir(watchPaths[1]);
  const usePolling = process.env.SHOGUN_WATCH_POLLING === "1" || process.env.VITEST === "true";
  logger?.info("message watcher started", { watchPaths, usePolling });
  const ledger = await MessageLedger.load(path.join(baseDir, "message_ledger.json"), logger);
  const inflight = new Set<string>();

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: false,
    usePolling,
    interval: usePolling ? 100 : undefined,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    }
  });

  const claimPendingMessage = async (filePath: string, to: string, from: string, baseName: string) => {
    const processingPath = buildProcessingPath(baseDir, to, from, baseName);
    await ensureDir(path.dirname(processingPath));
    try {
      await fs.rename(filePath, processingPath);
    } catch (error) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }
  };

  const moveProcessingToHistory = async (processingPath: string, historyPath: string) => {
    await ensureDir(path.dirname(historyPath));
    try {
      await fs.rename(processingPath, historyPath);
      return true;
    } catch (error) {
      if (isNoEntryError(error)) {
        try {
          const stat = await fs.stat(historyPath);
          return stat.isFile();
        } catch {
          return false;
        }
      }
      throw error;
    }
  };

  const processClaimedMessage = async (filePath: string) => {
    if (inflight.has(filePath)) return;
    inflight.add(filePath);
    try {
      const parsed = parsePath(filePath, baseDir);
      if (!parsed || parsed.queueDir !== "message_processing") return;
      const { to, from, stem, baseName } = parsed;
      const idempotencyKey = toIdempotencyKey(baseDir, filePath);

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (isNoEntryError(error)) {
          logger?.warn("message file missing before stat", { filePath });
          return;
        }
        throw error;
      }
      const createdAt = stat.mtime.toISOString();

      let body: string;
      try {
        body = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        if (isNoEntryError(error)) {
          logger?.warn("message file missing before read", { filePath });
          return;
        }
        throw error;
      }

      const parsedTitle = parseTitle(stem);
      const threadId = parsedTitle.threadId ?? stateStore.getLastActiveThread();
      if (!threadId) {
        logger?.warn("message ignored: threadId missing", { filePath, to, from, baseName });
        return;
      }

      const message: ShogunMessage = {
        id: stem,
        threadId,
        from: from as ShogunMessage["from"],
        to: to as ShogunMessage["to"],
        title: parsedTitle.title,
        body,
        createdAt
      };

      logger?.info("message file detected", {
        threadId,
        from: message.from,
        to: message.to,
        title: message.title,
        filePath
      });

      if (!ledger.isAtLeast(idempotencyKey, "history")) {
        await historyStore.appendMessage(threadId, message);
        await ledger.mark(idempotencyKey, "history");
      }

      if (!ledger.isAtLeast(idempotencyKey, "job_done")) {
        await handlers.onMessage(message);
        await ledger.mark(idempotencyKey, "job_done");
      }

      const historyPath = buildHistoryPath(historyDir, threadId, to, from, stem);
      const moved = await moveProcessingToHistory(filePath, historyPath);
      if (moved) {
        await ledger.mark(idempotencyKey, "done");
      }
    } catch (error) {
      logger?.error("message watcher add error", { error, filePath });
    } finally {
      inflight.delete(filePath);
    }
  };

  watcher.on("add", async (filePath) => {
    try {
      const parsed = parsePath(filePath, baseDir);
      if (!parsed) return;
      if (parsed.queueDir === "message_to") {
        await claimPendingMessage(filePath, parsed.to, parsed.from, parsed.baseName);
        return;
      }
      void processClaimedMessage(filePath);
    } catch (error) {
      logger?.error("message watcher add error", { error, filePath });
    }
  });

  watcher.on("error", (error) => {
    logger?.error("message watcher error", { error });
  });

  return watcher;
};
