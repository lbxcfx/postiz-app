#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/.runtime/logs"
PID_DIR="${ROOT_DIR}/.runtime/pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

start_bg() {
  local name="$1"
  local cmd="$2"
  local log_file="${LOG_DIR}/${name}.manual.log"
  local pid_file="${PID_DIR}/${name}.manual.pid"

  nohup bash -lc "cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  echo "$!" > "${pid_file}"
  echo "[STARTED] ${name} pid=$(cat "${pid_file}")"
}

start_bg "backend" "export NODE_OPTIONS=\${NODE_OPTIONS:---max-old-space-size=4096}; pnpm --filter ./apps/backend run dev"
start_bg "frontend" "export NODE_OPTIONS=\${NODE_OPTIONS:---max-old-space-size=4096}; pnpm --filter ./apps/frontend run dev"
start_bg "mediacrawler" "cd MediaCrawler && python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload"

echo "[DONE] manual-start triggered"
