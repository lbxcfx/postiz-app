#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_DIR="${RUNTIME_DIR}/pids"
USE_LOCAL_POSTGRES_REDIS="${USE_LOCAL_POSTGRES_REDIS:-1}"
USE_LOCAL_TEMPORAL="${USE_LOCAL_TEMPORAL:-1}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8080}"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

start_proc() {
  local name="$1"
  local cmd="$2"
  local pid_file="${PID_DIR}/${name}.minimal.pid"
  local log_file="${LOG_DIR}/${name}.minimal.log"

  if [[ -f "${pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      echo "[RESTART] ${name} (old pid=${old_pid})"
      kill "${old_pid}" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "${old_pid}" >/dev/null 2>&1 || true
    fi
    rm -f "${pid_file}"
  fi

  echo "[START] ${name}"
  nohup bash -lc "cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 &
  echo $! >"${pid_file}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] Missing command: $1"
    exit 1
  }
}

start_local_temporal() {
  require_cmd temporal
  start_proc "temporal" "temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-ip 127.0.0.1 --ui-port ${TEMPORAL_UI_PORT} --db-filename ${RUNTIME_DIR}/temporal/temporal-dev.db"
}

echo "[STEP] Infra up"
if [[ "${USE_LOCAL_TEMPORAL}" == "1" ]]; then
  start_local_temporal
elif [[ "${USE_LOCAL_POSTGRES_REDIS}" == "1" ]]; then
  docker compose -f "${ROOT_DIR}/docker-compose.dev.yaml" up -d \
    temporal-postgresql temporal-elasticsearch temporal temporal-ui temporal-admin-tools
else
  docker compose -f "${ROOT_DIR}/docker-compose.dev.yaml" up -d \
    postiz-postgres postiz-redis postiz-pg-admin \
    temporal-postgresql temporal-elasticsearch temporal temporal-ui
fi

echo "[STEP] App up (minimal)"
BACKEND_DIST="apps/backend/dist/apps/backend/src/main.js"
ORCHESTRATOR_DIST="apps/orchestrator/dist/apps/orchestrator/src/main.js"

if [[ -f "${ROOT_DIR}/${BACKEND_DIST}" ]]; then
  start_proc "backend" "node -r dotenv/config ${BACKEND_DIST} dotenv_config_path=.env"
else
  echo "[WARN] backend dist missing, fallback to pnpm dev"
  start_proc "backend" "pnpm --filter ./apps/backend run dev"
fi

if [[ -f "${ROOT_DIR}/${ORCHESTRATOR_DIST}" ]]; then
  start_proc "orchestrator" "node -r dotenv/config ${ORCHESTRATOR_DIST} dotenv_config_path=.env"
else
  echo "[WARN] orchestrator dist missing, fallback to pnpm dev"
  start_proc "orchestrator" "pnpm --filter ./apps/orchestrator run dev"
fi
start_proc "mediacrawler" "cd MediaCrawler && uv run uvicorn api.main:app --host 0.0.0.0 --port 8081"

echo "[DONE] minimal stack started"
echo "[INFO] Logs: ${LOG_DIR}"
echo "[INFO] PIDs: ${PID_DIR}"
