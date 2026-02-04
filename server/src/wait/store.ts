import fs from "node:fs/promises";
import path from "node:path";
import type { AgentId, ShogunMessage } from "@ai-shogun/shared";
import { ensureDir, readJsonFile, writeJsonFile } from "../utils.js";

export type WaitRecordStatus = "pending" | "received" | "timeout";

export interface WaitRecord {
  version: 1;
  key: string;
  status: WaitRecordStatus;
  threadId: string;
  agentId: AgentId;
  providerThreadId: string;
  timeoutMs: number;
  messageId: string;
  messageFrom: AgentId;
  messageTo: AgentId;
  messageTitle: string;
  messageCreatedAt: string;
  createdAt: string;
  updatedAt: string;
  receivedAt?: string;
  receivedMessage?: ShogunMessage;
}

const isJsonFile = (name: string) => name.endsWith(".json");

export class WaitStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  static buildKey(threadId: string, agentId: AgentId) {
    return `${threadId}__${agentId}`;
  }

  private pendingDir() {
    return path.join(this.baseDir, "waits", "pending");
  }

  private recordPath(key: string) {
    return path.join(this.pendingDir(), `${key}.json`);
  }

  async upsert(record: WaitRecord) {
    await ensureDir(this.pendingDir());
    await writeJsonFile(this.recordPath(record.key), record);
  }

  async load(key: string): Promise<WaitRecord | null> {
    return await readJsonFile<WaitRecord>(this.recordPath(key));
  }

  async remove(key: string) {
    try {
      await fs.rm(this.recordPath(key), { force: true });
    } catch {
      // ignore
    }
  }

  async list(): Promise<WaitRecord[]> {
    await ensureDir(this.pendingDir());
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.pendingDir());
    } catch {
      return [];
    }
    const records: WaitRecord[] = [];
    for (const entry of entries) {
      if (!isJsonFile(entry)) continue;
      const record = await readJsonFile<WaitRecord>(path.join(this.pendingDir(), entry));
      if (record) records.push(record);
    }
    return records;
  }
}

