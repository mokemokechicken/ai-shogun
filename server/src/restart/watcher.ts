import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import type { Logger } from "../logger.js";
import { ensureDir } from "../utils.js";
import { MessageLedger } from "../message/ledger.js";

export const RESTART_EXIT_CODE = 75;

export interface RestartRequest {
  id: string;
  requestedAt: string;
  reason?: string;
  payload?: unknown;
  raw?: string;
}

export interface RestartWatcherHandlers {
  onRestart: (_request: RestartRequest) => Promise<void> | void;
}

type QueueDir = "requests" | "processing";

const isNoEntryError = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

const parsePath = (filePath: string, restartDir: string) => {
  const relative = path.relative(restartDir, filePath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2) return null;
  const [queueDir, fileName] = parts;
  if ((queueDir !== "requests" && queueDir !== "processing") || !fileName.endsWith(".json")) return null;
  return { queueDir: queueDir as QueueDir, baseName: fileName, stem: path.parse(fileName).name };
};

const toIdempotencyKey = (restartDir: string, filePath: string) => {
  const relative = path.relative(restartDir, filePath);
  const parts = relative.split(path.sep);
  if (parts[0] === "processing") {
    parts[0] = "requests";
  }
  return parts.join("/");
};

const buildProcessingPath = (restartDir: string, baseName: string) => path.join(restartDir, "processing", baseName);
const buildHistoryPath = (restartDir: string, baseName: string) => path.join(restartDir, "history", baseName);

const parseRequestBody = (body: string) => {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const startRestartWatcher = async (
  baseDir: string,
  handlers: RestartWatcherHandlers,
  logger?: Logger
) => {
  const restartDir = path.join(baseDir, "tmp", "restart");
  const watchPaths = [path.join(restartDir, "requests"), path.join(restartDir, "processing")];
  await ensureDir(watchPaths[0]);
  await ensureDir(watchPaths[1]);
  await ensureDir(path.join(restartDir, "history"));

  const usePolling = process.env.SHOGUN_WATCH_POLLING === "1" || process.env.VITEST === "true";
  logger?.info("restart watcher started", { watchPaths, usePolling });

  const ledger = await MessageLedger.load(path.join(restartDir, "restart_ledger.json"), logger);
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

  const claimPendingRequest = async (filePath: string, baseName: string) => {
    const processingPath = buildProcessingPath(restartDir, baseName);
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

  const processClaimedRequest = async (filePath: string) => {
    if (inflight.has(filePath)) return;
    inflight.add(filePath);
    try {
      const parsed = parsePath(filePath, restartDir);
      if (!parsed || parsed.queueDir !== "processing") return;
      const { stem, baseName } = parsed;
      const idempotencyKey = toIdempotencyKey(restartDir, filePath);

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (isNoEntryError(error)) {
          logger?.warn("restart file missing before stat", { filePath });
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
          logger?.warn("restart file missing before read", { filePath });
          return;
        }
        throw error;
      }

      const payload = parseRequestBody(body);
      const reason = payload && typeof payload.reason === "string" ? payload.reason : undefined;
      const requestedAt = payload && typeof payload.requestedAt === "string" ? payload.requestedAt : createdAt;
      const id = payload && typeof payload.id === "string" ? payload.id : stem;

      const request: RestartRequest = {
        id,
        requestedAt,
        reason,
        payload: payload ?? undefined,
        raw: payload ? undefined : body
      };

      logger?.info("restart request detected", { id: request.id, requestedAt, reason, filePath });

      if (!ledger.isAtLeast(idempotencyKey, "job_done")) {
        await handlers.onRestart(request);
        await ledger.mark(idempotencyKey, "job_done");
      }

      const historyPath = buildHistoryPath(restartDir, baseName);
      const moved = await moveProcessingToHistory(filePath, historyPath);
      if (moved) {
        await ledger.mark(idempotencyKey, "done");
      }
    } catch (error) {
      logger?.error("restart watcher add error", { error, filePath });
    } finally {
      inflight.delete(filePath);
    }
  };

  watcher.on("add", async (filePath) => {
    try {
      const parsed = parsePath(filePath, restartDir);
      if (!parsed) return;
      if (parsed.queueDir === "requests") {
        await claimPendingRequest(filePath, parsed.baseName);
        return;
      }
      void processClaimedRequest(filePath);
    } catch (error) {
      logger?.error("restart watcher add error", { error, filePath });
    }
  });

  watcher.on("error", (error) => {
    logger?.error("restart watcher error", { error });
  });

  return watcher;
};
