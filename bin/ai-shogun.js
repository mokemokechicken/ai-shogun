#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const usage = `
ai-shogun [options]

Options:
  -p, --port <port>     Server port (default: 4090 or SHOGUN_PORT)
  --web-port <port>     Web dev server port (default: 4091 or SHOGUN_WEB_PORT)
  --root <dir>          Workspace root (default: current directory)
  --web-dev             Force Vite dev server
  --no-web              Do not start web dev server
  -h, --help            Show help
`;

const args = process.argv.slice(2);
const options = {
  port: undefined,
  webPort: undefined,
  root: undefined,
  webDev: false,
  noWeb: false,
  help: false
};

const parsePort = (value, label) => {
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid ${label}: ${value}`);
    process.exit(1);
  }
  return Math.trunc(port);
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    options.help = true;
    continue;
  }
  if (arg === "-p" || arg === "--port") {
    const value = args[i + 1];
    if (!value) {
      console.error("Missing value for --port");
      process.exit(1);
    }
    options.port = parsePort(value, "port");
    i += 1;
    continue;
  }
  if (arg === "--web-port") {
    const value = args[i + 1];
    if (!value) {
      console.error("Missing value for --web-port");
      process.exit(1);
    }
    options.webPort = parsePort(value, "web port");
    i += 1;
    continue;
  }
  if (arg === "--root") {
    const value = args[i + 1];
    if (!value) {
      console.error("Missing value for --root");
      process.exit(1);
    }
    options.root = value;
    i += 1;
    continue;
  }
  if (arg === "--web-dev") {
    options.webDev = true;
    continue;
  }
  if (arg === "--no-web") {
    options.noWeb = true;
    continue;
  }
  console.error(`Unknown argument: ${arg}`);
  console.log(usage);
  process.exit(1);
}

if (options.help) {
  console.log(usage);
  process.exit(0);
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = options.root ? path.resolve(options.root) : process.cwd();

const serverPort = options.port ?? parsePort(process.env.SHOGUN_PORT ?? "4090", "port");
const webPort = options.webPort ?? parsePort(process.env.SHOGUN_WEB_PORT ?? "4091", "web port");

const serverDist = path.join(appDir, "server", "dist", "index.js");
const sharedDist = path.join(appDir, "shared", "dist", "index.js");
const webDist = path.join(appDir, "web", "dist", "index.html");

const hasServerDist = fs.existsSync(serverDist);
const hasSharedDist = fs.existsSync(sharedDist);
const hasWebDist = fs.existsSync(webDist);

const useWebDev = !options.noWeb && (options.webDev || !hasWebDist);

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const runSync = (label, cmd, cmdArgs, envOverride) => {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: appDir,
    env: { ...process.env, ...envOverride }
  });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
};

const ensureNodeModules = (label, dirPath) => {
  if (fs.existsSync(path.join(dirPath, "node_modules"))) {
    return;
  }
  runSync(label, npmCmd, ["--prefix", dirPath, "install"]);
};

const ensureBuild = () => {
  if (!hasSharedDist) {
    ensureNodeModules("shared install", path.join(appDir, "shared"));
    runSync("shared build", npmCmd, ["--prefix", path.join(appDir, "shared"), "run", "build"]);
  }
  if (!hasServerDist) {
    ensureNodeModules("server install", path.join(appDir, "server"));
    runSync("server build", npmCmd, ["--prefix", path.join(appDir, "server"), "run", "build"]);
  }
  if (!useWebDev && !hasWebDist) {
    ensureNodeModules("web install", path.join(appDir, "web"));
    runSync("web build", npmCmd, ["--prefix", path.join(appDir, "web"), "run", "build"]);
  }
};

ensureBuild();

const serverDistReady = fs.existsSync(serverDist);

const childEnv = {
  ...process.env,
  SHOGUN_ROOT: workspaceDir,
  SHOGUN_PORT: String(serverPort),
  SHOGUN_WEB_PORT: String(webPort)
};

// Keep in sync with server/src/restart/watcher.ts
const RESTART_EXIT_CODE = 75;

const children = [];
let shuttingDown = false;

const spawnChild = (label, cmd, cmdArgs, extraEnv) => {
  const child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: appDir,
    env: { ...childEnv, ...extraEnv }
  });
  child.on("exit", (code, signal) => {
    const index = children.indexOf(child);
    if (index !== -1) {
      children.splice(index, 1);
    }
    if (label === "server" && code === RESTART_EXIT_CODE && !shuttingDown) {
      spawnChild(label, cmd, cmdArgs, extraEnv);
      return;
    }
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (!other.killed) {
        other.kill("SIGTERM");
      }
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  children.push(child);
  return child;
};

if (serverDistReady) {
  spawnChild("server", process.execPath, [serverDist]);
} else {
  spawnChild("server", npmCmd, ["--prefix", path.join(appDir, "server"), "run", "dev"]);
}

if (useWebDev) {
  ensureNodeModules("web install", path.join(appDir, "web"));
  spawnChild("web", npmCmd, ["--prefix", path.join(appDir, "web"), "run", "dev"]);
}

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(0);
});

const serverUrl = `http://localhost:${serverPort}`;
const webUrl = useWebDev ? `http://localhost:${webPort}` : serverUrl;
console.log(`AI Shogun started (workspace: ${workspaceDir})`);
console.log(`Server: ${serverUrl}`);
if (!options.noWeb) {
  console.log(`Web: ${webUrl}`);
}
