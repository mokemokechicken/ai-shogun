#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../../" && pwd)"
STATE_DIR="${ROOT_DIR}/.shogun/tmp/dev-server-restart"
PID_FILE="${STATE_DIR}/dev.pid"
LOG_FILE="${STATE_DIR}/dev.log"

usage() {
  echo "Usage: $0 {start|stop|restart|status}"
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d ' \n' < "$PID_FILE"
  fi
}

is_running() {
  local pid
  pid="$(read_pid || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

start() {
  ensure_state_dir
  if is_running; then
    echo "already running (pid $(read_pid))"
    return 0
  fi
  rm -f "$PID_FILE"
  : > "$LOG_FILE"
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "cd \"$ROOT_DIR\"; exec npm run dev" >"$LOG_FILE" 2>&1 &
  else
    nohup bash -c "cd \"$ROOT_DIR\"; exec npm run dev" >"$LOG_FILE" 2>&1 &
  fi
  echo $! > "$PID_FILE"
  echo "started (pid $(read_pid))"
}

stop() {
  local pid
  pid="$(read_pid || true)"
  if [[ -z "$pid" ]]; then
    echo "not running (pid file missing)"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "stale pid removed"
    return 0
  fi
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -P "$pid" 2>/dev/null || true
  fi
  for _ in {1..25}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped"
      return 0
    fi
    sleep 0.2
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  if command -v pkill >/dev/null 2>&1; then
    pkill -KILL -P "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "stopped (forced)"
}

status() {
  if is_running; then
    echo "running (pid $(read_pid))"
  else
    echo "stopped"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) usage; exit 1 ;;
 esac
