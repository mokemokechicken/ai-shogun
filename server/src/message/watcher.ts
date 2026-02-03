import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import { nanoid } from "nanoid";
import type { ShogunMessage } from "@ai-shogun/shared";
import { ensureDir } from "../utils.js";
import type { HistoryStore } from "../history/store.js";
import type { StateStore } from "../state/store.js";
import type { Logger } from "../logger.js";

export interface MessageWatcherHandlers {
  onMessage: (_message: ShogunMessage) => Promise<void> | void;
}

const isNoEntryError = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

const parsePath = (filePath: string, baseDir: string) => {
  const relative = path.relative(baseDir, filePath);
  const parts = relative.split(path.sep);
  if (parts.length < 5) return null;
  const [messageTo, to, fromLabel, from, fileName] = parts;
  if (messageTo !== "message_to" || fromLabel !== "from") return null;
  if (!fileName.endsWith(".md")) return null;
  return { to, from, fileName: path.parse(fileName).name };
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

export const startMessageWatcher = (
  baseDir: string,
  historyDir: string,
  historyStore: HistoryStore,
  stateStore: StateStore,
  handlers: MessageWatcherHandlers,
  logger?: Logger
) => {
  const watchPath = path.join(baseDir, "message_to");
  const usePolling = process.env.SHOGUN_WATCH_POLLING === "1" || process.env.VITEST === "true";
  logger?.info("message watcher started", { watchPath, usePolling });
  const watcher = chokidar.watch(watchPath, {
    ignoreInitial: false,
    usePolling,
    interval: usePolling ? 100 : undefined,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    }
  });

  watcher.on("add", async (filePath) => {
    try {
      const parsed = parsePath(filePath, baseDir);
      if (!parsed) return;
      const { to, from, fileName } = parsed;
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
      const parsedTitle = parseTitle(fileName);
      const threadId = parsedTitle.threadId ?? stateStore.getLastActiveThread();
      if (!threadId) {
        logger?.warn("message ignored: threadId missing", { filePath, to, from, fileName });
        return;
      }

      const message: ShogunMessage = {
        id: nanoid(),
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

      await handlers.onMessage(message);

      const historyPath = path.join(historyDir, threadId, "message_to", to, "from", from, `${fileName}.md`);
      await ensureDir(path.dirname(historyPath));
      try {
        await fs.rename(filePath, historyPath);
      } catch (error) {
        if (isNoEntryError(error)) {
          logger?.warn("message file missing during move", { filePath, historyPath });
        } else {
          throw error;
        }
      }
      await historyStore.appendMessage(threadId, message);
    } catch (error) {
      logger?.error("message watcher add error", { error, filePath });
    }
  });

  watcher.on("error", (error) => {
    logger?.error("message watcher error", { error });
  });

  return watcher;
};
