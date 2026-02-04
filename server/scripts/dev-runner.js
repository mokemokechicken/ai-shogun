import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Keep in sync with server/src/restart/watcher.ts
const RESTART_EXIT_CODE = 75;

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCmd = process.platform === "win32" ? "tsx.cmd" : "tsx";
const tsxBin = path.join(appDir, "node_modules", ".bin", tsxCmd);

let shuttingDown = false;
let child = null;

const spawnChild = () => {
  child = spawn(tsxBin, ["src/index.ts"], {
    stdio: "inherit",
    cwd: appDir,
    env: { ...process.env }
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }
    if (code === RESTART_EXIT_CODE) {
      spawnChild();
      return;
    }
    shuttingDown = true;
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
};

const forwardSignal = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

spawnChild();
