import fs from "node:fs/promises";
import path from "node:path";
import type { ShogunMessage } from "@ai-shogun/shared";
import { ensureDir } from "../utils.js";

export class HistoryStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private threadDir(threadId: string) {
    return path.join(this.baseDir, threadId);
  }

  private logPath(threadId: string) {
    return path.join(this.threadDir(threadId), "messages.jsonl");
  }

  async appendMessage(threadId: string, message: ShogunMessage) {
    const logPath = this.logPath(threadId);
    await ensureDir(path.dirname(logPath));
    await fs.appendFile(logPath, `${JSON.stringify(message)}\n`, "utf-8");
  }

  async listMessages(threadId: string): Promise<ShogunMessage[]> {
    const logPath = this.logPath(threadId);
    try {
      const raw = await fs.readFile(logPath, "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ShogunMessage)
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
