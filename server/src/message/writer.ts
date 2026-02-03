import path from "node:path";
import fs from "node:fs/promises";
import { nanoid } from "nanoid";
import { ensureDir, slugify, toFileTimestamp } from "../utils.js";

export interface MessageWriteInput {
  baseDir: string;
  threadId: string;
  from: string;
  to: string;
  title: string;
  body: string;
}

export const buildMessageTitle = (threadId: string, title: string) => {
  const slug = slugify(title);
  const unique = nanoid(6);
  return `${threadId}__${toFileTimestamp()}-${unique}__${slug}`;
};

export const writeMessageFile = async ({
  baseDir,
  threadId,
  from,
  to,
  title,
  body
}: MessageWriteInput) => {
  const messageTitle = buildMessageTitle(threadId, title);
  const filePath = path.join(baseDir, "message_to", to, "from", from, `${messageTitle}.md`);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(tempPath, body, "utf-8");
  await fs.rename(tempPath, filePath);
  return filePath;
};
