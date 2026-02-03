import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./utils.js";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const serializeError = (value: unknown) => {
  if (value instanceof Error) {
    const error = value as Error & { code?: string };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    };
  }
  if (typeof value === "string") {
    return { message: value };
  }
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
};

const normalizeMeta = (meta?: Record<string, unknown>) => {
  if (!meta) return undefined;
  const copy: Record<string, unknown> = { ...meta };
  if ("error" in copy) {
    copy.error = serializeError(copy.error);
  }
  return copy;
};

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: "log serialization failed", raw: String(value) });
  }
};

export const createLogger = (baseDir: string, name: string): Logger => {
  const logDir = path.join(baseDir, "logs");
  const logPath = path.join(logDir, `${name}.log`);
  let dirReady: Promise<void> | null = null;

  const ensureLogDir = () => {
    if (!dirReady) {
      dirReady = ensureDir(logDir);
    }
    return dirReady;
  };

  const writeLine = async (line: string) => {
    await ensureLogDir();
    await fs.appendFile(logPath, `${line}\n`, "utf-8");
  };

  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      source: name,
      pid: process.pid,
      message,
      ...(normalizeMeta(meta) ?? {})
    };
    void writeLine(safeStringify(entry));
  };

  return {
    log,
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
};

export const registerProcessHandlers = (logger: Logger) => {
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", { error });
  });
  process.on("unhandledRejection", (error) => {
    logger.error("unhandledRejection", { error });
  });
};
