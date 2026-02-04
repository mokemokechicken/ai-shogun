import type { Logger } from "../logger.js";
import { readJsonFile, writeJsonFile } from "../utils.js";

export type LedgerStatus = "history" | "job_done" | "done";

export interface LedgerEntry {
  status: LedgerStatus;
  updatedAt: string;
}

interface LedgerFile {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

const statusRank: Record<LedgerStatus, number> = {
  history: 1,
  job_done: 2,
  done: 3
};

const shouldUpgrade = (current: LedgerStatus, next: LedgerStatus) => statusRank[next] > statusRank[current];

export class MessageLedger {
  private filePath: string;
  private entries: Record<string, LedgerEntry>;
  private saveChain: Promise<void> = Promise.resolve();
  private logger?: Logger;

  private constructor(filePath: string, entries: Record<string, LedgerEntry>, logger?: Logger) {
    this.filePath = filePath;
    this.entries = entries;
    this.logger = logger;
  }

  static async load(filePath: string, logger?: Logger) {
    const data = await readJsonFile<LedgerFile>(filePath);
    if (!data || typeof data !== "object") {
      return new MessageLedger(filePath, {}, logger);
    }
    if (data.version !== 1 || typeof data.entries !== "object" || data.entries === null) {
      logger?.warn("message ledger: invalid format; starting fresh", { filePath });
      return new MessageLedger(filePath, {}, logger);
    }
    return new MessageLedger(filePath, data.entries ?? {}, logger);
  }

  get(key: string) {
    return this.entries[key];
  }

  isAtLeast(key: string, status: LedgerStatus) {
    const entry = this.entries[key];
    if (!entry) return false;
    return statusRank[entry.status] >= statusRank[status];
  }

  async mark(key: string, status: LedgerStatus) {
    const now = new Date().toISOString();
    const existing = this.entries[key];
    if (existing) {
      if (!shouldUpgrade(existing.status, status)) {
        return;
      }
    }
    this.entries[key] = { status, updatedAt: now };
    await this.save();
  }

  private async save() {
    this.saveChain = this.saveChain.then(
      () => writeJsonFile(this.filePath, { version: 1, entries: this.entries } satisfies LedgerFile),
      () => writeJsonFile(this.filePath, { version: 1, entries: this.entries } satisfies LedgerFile)
    );
    await this.saveChain;
  }
}

