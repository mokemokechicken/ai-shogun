import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

const rawConfigSchema = z.object({
  baseDir: z.string().optional(),
  historyDir: z.string().optional(),
  ashigaruCount: z.number().int().positive().optional(),
  provider: z.string().optional(),
  models: z
    .object({
      default: z.string().optional(),
      shogun: z.string().optional(),
      karou: z.string().optional(),
      ashigaru: z.string().optional()
    })
    .optional(),
  codex: z
    .object({
      config: z.record(z.string(), z.unknown()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      reasoningEffort: z.record(z.string(), z.string()).optional(),
      additionalDirectories: z.array(z.string()).optional()
    })
    .optional(),
  ashigaruProfiles: z
    .record(
      z.string(),
      z.object({
        name: z.string(),
        profile: z.string()
      })
    )
    .optional(),
  server: z
    .object({
      port: z.number().int().positive().optional()
    })
    .optional()
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

export interface AppConfig {
  rootDir: string;
  baseDir: string;
  historyDir: string;
  ashigaruCount: number;
  provider: string;
  models: {
    default: string;
    shogun?: string;
    karou?: string;
    ashigaru?: string;
  };
  codex: {
    config: Record<string, unknown>;
    env: Record<string, string>;
    reasoningEffort: Record<string, string>;
    additionalDirectories: string[];
  };
  ashigaruProfiles: Record<string, { name: string; profile: string }>;
  server: {
    port: number;
  };
}

const parseEnvNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const envString = (value: string | undefined, fallback: string) => value ?? fallback;

export const loadConfig = async (rootDir: string): Promise<AppConfig> => {
  const configPath = path.join(rootDir, ".shogun", "config", "shogun.config.json");
  let fileConfig: RawConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    fileConfig = rawConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const baseDir = path.resolve(rootDir, fileConfig.baseDir ?? ".shogun");
  const historyDir = path.resolve(
    rootDir,
    fileConfig.historyDir ?? path.join(baseDir, "history")
  );

  const defaultModel = envString(
    fileConfig.models?.default ?? process.env.SHOGUN_MODEL_DEFAULT ?? process.env.CODEX_MODEL,
    "gpt-5.2-codex"
  );
  const additionalDirectories = (fileConfig.codex?.additionalDirectories ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(rootDir, entry));

  return {
    rootDir,
    baseDir,
    historyDir,
    ashigaruCount: fileConfig.ashigaruCount ?? parseEnvNumber(process.env.SHOGUN_ASHIGARU_COUNT, 5),
    provider: fileConfig.provider ?? process.env.SHOGUN_PROVIDER ?? "codex",
    models: {
      default: defaultModel,
      shogun: fileConfig.models?.shogun ?? process.env.SHOGUN_MODEL_SHOGUN,
      karou: fileConfig.models?.karou ?? process.env.SHOGUN_MODEL_KAROU,
      ashigaru: fileConfig.models?.ashigaru ?? process.env.SHOGUN_MODEL_ASHIGARU
    },
    codex: {
      config: {
        approval_policy: "never",
        ...(fileConfig.codex?.config ?? {})
      },
      env: {
        ...(fileConfig.codex?.env ?? {})
      },
      reasoningEffort: {
        ...(fileConfig.codex?.reasoningEffort ?? {})
      },
      additionalDirectories
    },
    ashigaruProfiles: {
      ...(fileConfig.ashigaruProfiles ?? {})
    },
    server: {
      port: fileConfig.server?.port ?? parseEnvNumber(process.env.SHOGUN_PORT, 4090)
    }
  };
};

const reasoningEffortValues = new Set<ModelReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);

const normalizeReasoningEffort = (value?: string): ModelReasoningEffort | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimaru") return "minimal";
  if (reasoningEffortValues.has(normalized as ModelReasoningEffort)) {
    return normalized as ModelReasoningEffort;
  }
  return undefined;
};

export const resolveReasoningEffort = (
  config: AppConfig,
  agentId: string,
  role: "shogun" | "karou" | "ashigaru"
) => {
  const map = config.codex.reasoningEffort ?? {};
  const raw =
    map[agentId] ??
    map[role] ??
    (role === "ashigaru" ? map.ashigaru : undefined) ??
    map.default;
  return { raw, value: normalizeReasoningEffort(raw) };
};

export const resolveRoleModel = (config: AppConfig, role: "shogun" | "karou" | "ashigaru") => {
  if (role === "shogun" && config.models.shogun) return config.models.shogun;
  if (role === "karou" && config.models.karou) return config.models.karou;
  if (role === "ashigaru" && config.models.ashigaru) return config.models.ashigaru;
  return config.models.default;
};
