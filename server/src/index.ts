import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import type { ThreadInfo, WsEvent, ShogunMessage } from "@ai-shogun/shared";
import { loadConfig } from "./config.js";
import { StateStore } from "./state/store.js";
import { HistoryStore } from "./history/store.js";
import { startMessageWatcher } from "./message/watcher.js";
import { writeMessageFile } from "./message/writer.js";
import { AgentManager } from "./agent/manager.js";
import { ensureDir } from "./utils.js";

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

const main = async () => {
  const rootDir = process.cwd();
  const config = await loadConfig(rootDir);

  await ensureDir(config.baseDir);
  await ensureDir(path.join(config.baseDir, "message_to"));
  await ensureDir(config.historyDir);

  const stateStore = await StateStore.load(path.join(config.baseDir, "state.json"));
  const historyStore = new HistoryStore(config.historyDir);
  const agentManager = new AgentManager(config, stateStore);

  for (const thread of stateStore.listThreads()) {
    await agentManager.initThread(thread.id);
  }

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

  startMessageWatcher(config.baseDir, config.historyDir, historyStore, stateStore, {
    onMessage: async (message: ShogunMessage) => {
      stateStore.updateThread(message.threadId, { updatedAt: new Date().toISOString() });
      stateStore.setLastActiveThread(message.threadId);
      await stateStore.save();

      broadcast(wss, { type: "message", message });

      if (message.to === "king") {
        return;
      }
      agentManager.enqueue(message.to, message);
    }
  });

  app.get("/api/threads", (_req, res) => {
    const threads = stateStore.listThreads().map(toThreadInfo);
    res.json({ threads });
  });

  app.post("/api/threads", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title : `Thread ${stateStore.listThreads().length + 1}`;
    const thread = stateStore.createThread(title);
    await agentManager.initThread(thread.id);
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

  app.post("/api/stop", (_req, res) => {
    broadcast(wss, { type: "stop", status: "requested" });
    agentManager.stopAll();
    broadcast(wss, { type: "stop", status: "completed" });
    res.json({ ok: true });
  });

  const staticDir = path.join(config.rootDir, "web", "dist");
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
  });
};

void main();
