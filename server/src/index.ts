import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import type { ThreadInfo, WsEvent, ShogunMessage } from "@ai-shogun/shared";
import { loadConfig } from "./config.js";
import { StateStore } from "./state/store.js";
import { HistoryStore } from "./history/store.js";
import { startMessageWatcher } from "./message/watcher.js";
import { RESTART_EXIT_CODE, startRestartWatcher } from "./restart/watcher.js";
import { writeMessageFile } from "./message/writer.js";
import { AgentManager } from "./agent/manager.js";
import { ensureDir } from "./utils.js";
import { createLogger, registerProcessHandlers } from "./logger.js";

const toThreadInfo = (thread: { id: string; title: string; createdAt: string; updatedAt: string }): ThreadInfo => ({
  id: thread.id,
  title: thread.title,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt
});

const broadcast = (wss: WebSocketServer, event: WsEvent) => {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
};

const resolveWorkspaceDir = () => {
  const envRoot = process.env.SHOGUN_ROOT?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  const npmInitCwd = process.env.INIT_CWD?.trim();
  if (npmInitCwd) {
    return path.resolve(npmInitCwd);
  }
  return process.cwd();
};

const resolveAppDir = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
};

const main = async () => {
  const rootDir = resolveWorkspaceDir();
  const appDir = resolveAppDir();
  const config = await loadConfig(rootDir);
  const logger = createLogger(config.baseDir, "server");
  registerProcessHandlers(logger);
  logger.info("process identity", {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    euid: typeof process.geteuid === "function" ? process.geteuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    egid: typeof process.getegid === "function" ? process.getegid() : null,
    user: process.env.USER ?? null,
    home: process.env.HOME ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
    shogunRoot: process.env.SHOGUN_ROOT ?? null,
    cwd: process.cwd()
  });

  await ensureDir(config.baseDir);
  await ensureDir(path.join(config.baseDir, "config"));
  const shogunGitignorePath = path.join(config.baseDir, ".gitignore");
  try {
    await fs.access(shogunGitignorePath);
  } catch {
	    const lines = [
	      "# Runtime data (generated)",
	      "logs/",
	      "history/",
	      "message_to/",
	      "message_processing/",
	      "waits/",
	      "message_ledger.json",
	      "state.json",
	      "tmp/"
	    ];
    await fs.writeFile(shogunGitignorePath, `${lines.join("\n")}\n`, "utf-8");
  }
  await ensureDir(path.join(config.baseDir, "message_to"));
  await ensureDir(path.join(config.baseDir, "message_processing"));
  await ensureDir(config.historyDir);
  await ensureDir(path.join(config.baseDir, "tmp"));
  const sharedRulesDir = path.join(config.baseDir, "rules");
  await ensureDir(sharedRulesDir);
  const sharedRulesIndexPath = path.join(sharedRulesDir, "index.md");
  const sharedRulesCommonPath = path.join(sharedRulesDir, "common.md");
  let hasCommon = false;
  try {
    await fs.access(sharedRulesCommonPath);
    hasCommon = true;
  } catch {
    hasCommon = false;
  }
  try {
    await fs.access(sharedRulesIndexPath);
  } catch {
    const lines = [
      "# Shared Rules Index",
      "",
      "- Add shared rules here or link to other files in this folder.",
      "- Keep this index updated so all agents share the same context."
    ];
    if (hasCommon) {
      lines.push("", "- [common](./common.md)");
    }
    await fs.writeFile(sharedRulesIndexPath, `${lines.join("\n")}\n`, "utf-8");
  }

  const sharedSkillsDir = path.join(config.baseDir, "skills");
  await ensureDir(sharedSkillsDir);
  const sharedSkillsIndexPath = path.join(sharedSkillsDir, "index.md");
  try {
    await fs.access(sharedSkillsIndexPath);
  } catch {
    const lines = [
      "# Skills Index",
      "",
      "- List local skills here and link to skill files in this folder.",
      "- Keep this index updated so karou/ashigaru always know available skills."
    ];
    await fs.writeFile(sharedSkillsIndexPath, `${lines.join("\n")}\n`, "utf-8");
  }

  const stateStore = await StateStore.load(path.join(config.baseDir, "state.json"));
  const historyStore = new HistoryStore(config.historyDir);
  const agentManager = new AgentManager(config, stateStore, logger);

  logger.info("server boot", {
    rootDir,
    baseDir: config.baseDir,
    historyDir: config.historyDir,
    provider: config.provider,
    ashigaruCount: config.ashigaruCount,
    port: config.server.port
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  agentManager.onStatusChange(() => {
    broadcast(wss, { type: "agent_status", agents: agentManager.getStatuses() });
  });

  let restarting = false;
  const messageWatcher = await startMessageWatcher(
    config.baseDir,
    config.historyDir,
    historyStore,
    stateStore,
    {
      onMessage: async (message: ShogunMessage) => {
        if (restarting) {
          logger.info("message skipped during restart", {
            threadId: message.threadId,
            from: message.from,
            to: message.to,
            title: message.title
          });
          return;
        }
        stateStore.updateThread(message.threadId, { updatedAt: new Date().toISOString() });
        stateStore.setLastActiveThread(message.threadId);
        await stateStore.save();

        broadcast(wss, { type: "message", message });

        if (message.to === "king") {
          return;
        }
        logger.info("message routed", {
          threadId: message.threadId,
          from: message.from,
          to: message.to,
          title: message.title
        });
        try {
          await agentManager.enqueue(message.to, message);
        } catch (error) {
          const isRestartStop =
            error instanceof Error &&
            (error.message.includes("agent stopped") || error.message.includes("agent aborted: stop"));
          if (restarting && isRestartStop) {
            logger.info("message enqueue skipped during restart", {
              threadId: message.threadId,
              from: message.from,
              to: message.to,
              title: message.title
            });
            return;
          }
          throw error;
        }
      }
    },
    logger
  );

  const restartWatcher = await startRestartWatcher(
    config.baseDir,
    {
      onRestart: async (request) => {
        if (restarting) return;
        restarting = true;
        logger.warn("restart requested", { id: request.id, requestedAt: request.requestedAt, reason: request.reason });
        agentManager.stopAll();
        await Promise.allSettled([messageWatcher.close(), restartWatcher.close()]);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
      onRestartComplete: async () => {
        process.exit(RESTART_EXIT_CODE);
      }
    },
    logger
  );

  app.get("/api/threads", (_req, res) => {
    const threads = stateStore.listThreads().map(toThreadInfo);
    res.json({ threads });
  });

  app.post("/api/threads", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title : `Thread ${stateStore.listThreads().length + 1}`;
    const thread = stateStore.createThread(title);
    await stateStore.save();
    broadcast(wss, { type: "threads", threads: stateStore.listThreads().map(toThreadInfo) });
    res.json(toThreadInfo(thread));
  });

  app.post("/api/threads/:id/select", async (req, res) => {
    const threadId = req.params.id;
    if (!stateStore.getThread(threadId)) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    stateStore.setLastActiveThread(threadId);
    await stateStore.save();
    res.json({ ok: true });
  });

  app.get("/api/threads/:id/messages", async (req, res) => {
    const threadId = req.params.id;
    if (!stateStore.getThread(threadId)) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const messages = await historyStore.listMessages(threadId);
    res.json({ messages });
  });

  app.post("/api/threads/:id/king-message", async (req, res) => {
    const threadId = req.params.id;
    if (!stateStore.getThread(threadId)) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!body.trim()) {
      res.status(400).json({ error: "body is required" });
      return;
    }
    const title = typeof req.body?.title === "string" && req.body.title ? req.body.title : "king-message";
    await writeMessageFile({
      baseDir: config.baseDir,
      threadId,
      from: "king",
      to: "shogun",
      title,
      body
    });
    res.json({ ok: true });
  });

  app.get("/api/agents", (_req, res) => {
    res.json({ agents: agentManager.getStatuses() });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ ashigaruProfiles: config.ashigaruProfiles ?? {} });
  });

  app.post("/api/stop", (_req, res) => {
    broadcast(wss, { type: "stop", status: "requested" });
    agentManager.stopAll();
    broadcast(wss, { type: "stop", status: "completed" });
    res.json({ ok: true });
  });

  const staticDir = path.join(appDir, "web", "dist");
  try {
    const stat = await fs.stat(staticDir);
    if (stat.isDirectory()) {
      app.use(express.static(staticDir));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(staticDir, "index.html"));
      });
    }
  } catch {
    // Ignore if not built
  }

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "threads", threads: stateStore.listThreads().map(toThreadInfo) } satisfies WsEvent));
    socket.send(JSON.stringify({ type: "agent_status", agents: agentManager.getStatuses() } satisfies WsEvent));
  });

  server.listen(config.server.port, () => {
    console.log(`AI Shogun server listening on http://localhost:${config.server.port}`);
    logger.info("server listening", { port: config.server.port });
  });
};

void main();
