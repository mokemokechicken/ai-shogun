#!/usr/bin/env bash
set -euo pipefail

log_path="${1:-.shogun/logs/server.log}"

if [[ "${log_path}" == "-h" || "${log_path}" == "--help" ]]; then
  cat <<'USAGE'
Usage: .shogun/scripts/check-server-log.sh [LOG_PATH]

Outputs:
  - tail20 (raw)
  - last 400 lines: error|warn|exception|fatal|traceback (case-insensitive) with global line numbers
  - whole file: "level":"(warn|error|fatal)" count, line numbers, latest ts
USAGE
  exit 0
fi

if [[ ! -f "${log_path}" ]]; then
  echo "ERROR: log not found: ${log_path}" >&2
  exit 1
fi

echo "== check-server-log =="
echo "log: ${log_path}"
echo

echo "== tail20 (raw) =="
tail -n 20 "${log_path}" || true
echo

echo "== last400: error|warn|exception|fatal|traceback (i), with global line numbers =="
total_lines="$(wc -l <"${log_path}" | tr -d ' ')"
if [[ "${total_lines}" -gt 399 ]]; then
  start_line="$((total_lines - 399))"
else
  start_line="1"
fi
echo "totalLines=${total_lines} startLine(last400)=${start_line}"

q2_matches="$(tail -n 400 "${log_path}" \
  | nl -ba -v "${start_line}" \
  | rg -i 'error|warn|exception|fatal|traceback' || true)"

if [[ -z "${q2_matches}" ]]; then
  echo "該当なし"
else
  printf '%s\n' "${q2_matches}"
fi
echo

echo "== all: \"level\":\"(warn|error|fatal)\" count/lineNumbers/latestTs =="
tmp="$(mktemp -t check-server-log.XXXXXX)"
trap 'rm -f "${tmp}"' EXIT

rg -n '"level":"(warn|error|fatal)"' "${log_path}" >"${tmp}" || true

level_count="$(wc -l <"${tmp}" | tr -d ' ')"
echo "count=${level_count}"

if [[ "${level_count}" -eq 0 ]]; then
  echo "lineNumbers: (none)"
  echo "latestTs: (none)"
  exit 0
fi

echo -n "lineNumbers: "
cut -d: -f1 "${tmp}" | paste -sd' ' -
latest_ts="$(
  TMP_FILE="${tmp}" python3 - <<'PY'
import re
import os
from pathlib import Path

tmp = Path(os.environ["TMP_FILE"])
max_ts = None
for line in tmp.read_text(errors="replace").splitlines():
    # rg -n output: "<lineNo>:<json...>"
    _, _, payload = line.partition(":")
    match = re.search(r'"ts":"([^"]+)"', payload)
    if not match:
        continue
    ts = match.group(1)
    if max_ts is None or ts > max_ts:
        max_ts = ts
print(max_ts or "")
PY
)"
echo "latestTs: ${latest_ts:-unknown}"
