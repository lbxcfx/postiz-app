#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

RUNTIME_DIR="${ROOT_DIR}/.runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_DIR="${RUNTIME_DIR}/pids"
mkdir -p "${LOG_DIR}" "${PID_DIR}"

start_bg() {
  local name="$1"
  local cmd="$2"
  local pid_file="${PID_DIR}/${name}.runner.pid"
  local log_file="${LOG_DIR}/${name}.runner.log"

  if [[ -f "${pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      kill "${old_pid}" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "${old_pid}" >/dev/null 2>&1 || true
    fi
    rm -f "${pid_file}"
  fi

  nohup bash -lc "cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 &
  echo $! >"${pid_file}"
}

wait_http() {
  local name="$1"
  local url="$2"
  local timeout_sec="${3:-60}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[OK] ${name} -> ${url}"
      return 0
    fi
    if (( "$(date +%s)" - started_at >= timeout_sec )); then
      echo "[FAIL] ${name} not ready -> ${url}"
      return 1
    fi
    sleep 1
  done
}

echo "[STEP] Infra"
docker compose -f "${ROOT_DIR}/docker-compose.dev.yaml" up -d \
  postiz-postgres postiz-redis postiz-pg-admin \
  temporal-postgresql temporal-elasticsearch temporal temporal-ui

echo "[STEP] Apps"
start_bg "backend" "node -r dotenv/config apps/backend/dist/apps/backend/src/main.js dotenv_config_path=.env"
start_bg "orchestrator" "node -r dotenv/config apps/orchestrator/dist/apps/orchestrator/src/main.js dotenv_config_path=.env"
start_bg "mediacrawler" "cd MediaCrawler && uv run uvicorn api.main:app --host 0.0.0.0 --port 8081"
start_bg "social_auto_upload" "cd social-auto-upload-main/social-auto-upload-main && python3 sau_backend.py"

echo "[STEP] Health"
wait_http "backend" "http://127.0.0.1:3000/docs" 90
wait_http "mediacrawler" "http://127.0.0.1:8081/api/health" 90
wait_http "social-auto-upload" "http://127.0.0.1:5409" 90

echo "[STEP] Live E2E"
node ./scripts/wsl/factory-live-e2e.js --live

echo "[DONE] run-factory-live-e2e-local passed"
