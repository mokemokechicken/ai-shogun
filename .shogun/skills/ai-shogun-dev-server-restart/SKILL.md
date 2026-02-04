---
name: ai-shogun-dev-server-restart
description: Restart or manage the ai-shogun local dev server (`npm run dev`) with PID tracking and safe stop/start. Use when you need to start/stop/restart the dev server, validate restart behavior, or recover from a hung `npm run dev` process.
---

# Ai Shogun Dev Server Restart

## Overview
Use the bundled control script to manage the dev server in a repeatable way. Store PID and logs under `.shogun/tmp/dev-server-restart/`.

## Quick Start
1. Run `bash .shogun/skills/ai-shogun-dev-server-restart/scripts/dev_server_ctl.sh start`
2. Restart with `bash .shogun/skills/ai-shogun-dev-server-restart/scripts/dev_server_ctl.sh restart`
3. Stop with `bash .shogun/skills/ai-shogun-dev-server-restart/scripts/dev_server_ctl.sh stop`
4. Check status with `bash .shogun/skills/ai-shogun-dev-server-restart/scripts/dev_server_ctl.sh status`

## Behavior
- Write PID to `.shogun/tmp/dev-server-restart/dev.pid`.
- Write logs to `.shogun/tmp/dev-server-restart/dev.log`.
- Refuse to start when the PID is already running and remove stale PID files.
- Send TERM to the process group when possible, wait, then send KILL as fallback.

## Notes
- Run from any directory; the script resolves the repo root relative to its location.
- Export env vars before running if you need overrides (example: `SHOGUN_PORT=4090`).

## Resources
- `scripts/dev_server_ctl.sh`: Start/stop/restart/status for `npm run dev` with PID tracking.
