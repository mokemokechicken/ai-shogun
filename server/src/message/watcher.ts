import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import { nanoid } from "nanoid";
import type { ShogunMessage } from "@ai-shogun/shared";
import { ensureDir } from "../utils.js";
import type { HistoryStore } from "../history/store.js";
import type { StateStore } from "../state/store.js";

export interface MessageWatcherHandlers {
  onMessage: (_message: ShogunMessage) => Promise<void> | void;
}

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
  handlers: MessageWatcherHandlers
) => {
  const watchPath = path.join(baseDir, "message_to");
  const usePolling = process.env.SHOGUN_WATCH_POLLING === "1" || process.env.VITEST === "true";
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
    const parsed = parsePath(filePath, baseDir);
    if (!parsed) return;
    const { to, from, fileName } = parsed;
    const stat = await fs.stat(filePath);
    const createdAt = stat.mtime.toISOString();
    const body = await fs.readFile(filePath, "utf-8");
    const parsedTitle = parseTitle(fileName);
    const threadId = parsedTitle.threadId ?? stateStore.getLastActiveThread();
    if (!threadId) return;

    const message: ShogunMessage = {
      id: nanoid(),
      threadId,
      from: from as ShogunMessage["from"],
      to: to as ShogunMessage["to"],
      title: parsedTitle.title,
      body,
      createdAt
    };

    await handlers.onMessage(message);

    const historyPath = path.join(historyDir, threadId, "message_to", to, "from", from, `${fileName}.md`);
    await ensureDir(path.dirname(historyPath));
    await fs.rename(filePath, historyPath);
    await historyStore.appendMessage(threadId, message);
  });

  return watcher;
};
