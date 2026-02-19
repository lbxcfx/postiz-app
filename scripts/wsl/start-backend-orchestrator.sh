#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/.runtime/logs"
PID_DIR="${ROOT_DIR}/.runtime/pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

start_bg() {
  local name="$1"
  local cmd="$2"
  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.manual.log"

  if [[ -f "${pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      echo "[SKIP] ${name} already running pid=${old_pid}"
      return
    fi
    rm -f "${pid_file}"
  fi

  echo "[START] ${name}"
  nohup bash -lc "cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 &
  echo $! >"${pid_file}"
}

if [[ ! -f "${ROOT_DIR}/apps/backend/dist/apps/backend/src/main.js" ]]; then
  echo "[FAIL] backend dist missing, run build first"
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/apps/orchestrator/dist/apps/orchestrator/src/main.js" ]]; then
  echo "[FAIL] orchestrator dist missing, run build first"
  exit 1
fi

start_bg "backend" "node -r dotenv/config apps/backend/dist/apps/backend/src/main.js dotenv_config_path=.env"
start_bg "orchestrator" "node -r dotenv/config apps/orchestrator/dist/apps/orchestrator/src/main.js dotenv_config_path=.env"

echo "[DONE] backend/orchestrator startup triggered"
