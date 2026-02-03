import fs from "node:fs/promises";
import path from "node:path";

export const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const slugify = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "message";
};

export const toFileTimestamp = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, "-");

export const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

export const writeJsonFile = async (filePath: string, data: unknown) => {
  const content = JSON.stringify(data, null, 2);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
};
