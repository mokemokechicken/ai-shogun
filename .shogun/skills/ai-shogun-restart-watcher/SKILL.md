---
name: ai-shogun-restart-watcher
description: Request a safe server restart via the restart watcher by dropping a JSON request file under .shogun/tmp/restart/requests. Use when you need to trigger an orderly restart of the server process.
---

# Ai Shogun Restart Watcher

## Overview
The server watches `.shogun/tmp/restart/requests` and restarts itself when a request file is detected. Files are moved to `processing/` and then `history/` with a ledger to avoid duplicate processing.

## Request Format
Create a **unique** JSON file in `.shogun/tmp/restart/requests`:

```json
{
  "id": "restart-20260204-01",
  "reason": "config changed",
  "requestedAt": "2026-02-04T22:40:00Z"
}
```

Notes:
- File name should be unique (ledger is file-name based).
- `id`, `reason`, `requestedAt` are optional but recommended.
- If the file is not valid JSON, the raw body is still accepted and logged.

## How It Works
1. The watcher moves the request to `processing/`.
2. It parses the request, runs restart handlers, then moves the file to `history/`.
3. Ledger updates are written to `.shogun/tmp/restart/restart_ledger.json`.
4. After history + ledger updates, the server exits with `RESTART_EXIT_CODE=75`.
5. `bin/ai-shogun.js` respawns the server on exit code 75.

## Troubleshooting
- If restart does not happen, ensure the server is running and has access to `.shogun/tmp/restart/requests`.
- If the same file name is reused, the ledger will ignore it; use a new file name.

## Related Files
- `server/src/restart/watcher.ts`
- `server/src/index.ts`
- `bin/ai-shogun.js`
