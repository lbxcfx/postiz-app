#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH:/usr/bin"
USE_LOCAL_TEMPORAL="${USE_LOCAL_TEMPORAL:-1}"
SKIP_DOCKER_INFRA="${SKIP_DOCKER_INFRA:-0}"
STOP_DOCKER_INFRA="${STOP_DOCKER_INFRA:-0}"

# Auto-fix docker path in WSL if needed
if ! command -v docker >/dev/null 2>&1; then
  DOCKER_EXE="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  if [[ -f "$DOCKER_EXE" ]]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$DOCKER_EXE" "$HOME/.local/bin/docker"
  fi
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
PID_DIR="${RUNTIME_DIR}/pids"

stop_proc() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if [[ ! -f "${pid_file}" ]]; then
    echo "[SKIP] ${name} pid file not found"
    return
  fi

  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if [[ -z "${pid}" ]]; then
    rm -f "${pid_file}"
    echo "[SKIP] ${name} pid empty"
    return
  fi

  if kill -0 "${pid}" >/dev/null 2>&1; then
    echo "[STOP] ${name} (pid=${pid})"
    pkill -P "${pid}" >/dev/null 2>&1 || true
    kill "${pid}" >/dev/null 2>&1 || true
    sleep 1
    pkill -9 -P "${pid}" >/dev/null 2>&1 || true
    kill -9 "${pid}" >/dev/null 2>&1 || true
  else
    echo "[SKIP] ${name} not running"
  fi

  rm -f "${pid_file}"
}

mkdir -p "${PID_DIR}"

stop_proc "backend"
stop_proc "frontend"
stop_proc "orchestrator"
stop_proc "social_auto_upload"
stop_proc "mediacrawler"
stop_proc "temporal"

resolve_fallback_compose_file() {
  local env_compose="${WIN_FALLBACK_COMPOSE_FILE:-}"
  local env_root="${WIN_FALLBACK_ROOT:-}"
  local root_compose="${ROOT_DIR}/docker-compose.dev.yaml"
  local legacy_compose="/mnt/f/postiz-app/docker-compose.dev.yaml"
  local candidate
  local candidates=()

  if [[ -n "${env_compose}" ]]; then
    candidates+=("${env_compose}")
  fi
  if [[ -n "${env_root}" ]]; then
    candidates+=("${env_root}/docker-compose.dev.yaml")
  fi
  if [[ "${ROOT_DIR}" == /mnt/* ]]; then
    candidates+=("${root_compose}")
  fi
  candidates+=("${legacy_compose}")

  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

echo "[STEP] Cleaning stale workspace processes"
if command -v pkill >/dev/null 2>&1; then
  # Best-effort cleanup for orphaned dev processes that are not tracked by pid files.
  cleanup_roots=("${ROOT_DIR}")
  if [[ -n "${WIN_FALLBACK_ROOT:-}" ]]; then
    cleanup_roots+=("${WIN_FALLBACK_ROOT}")
  fi
  cleanup_roots+=("/mnt/f/postiz-app")

  for cleanup_root in "${cleanup_roots[@]}"; do
    pkill -f "${cleanup_root}/node_modules/.bin/next dev -p 4200" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/node_modules/.bin/../@nestjs/cli/bin/nest.js start --watch --entryFile=./apps/backend/src/main" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/node_modules/.bin/../@nestjs/cli/bin/nest.js start --watch --entryFile=./apps/orchestrator/src/main" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/apps/backend/dist/apps/backend/src/main.js" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/apps/backend/dist/apps/backend/src/main" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/apps/orchestrator/dist/apps/orchestrator/src/main.js" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/apps/orchestrator/dist/apps/orchestrator/src/main" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/social-auto-upload-main/social-auto-upload-main/sau_backend.py" >/dev/null 2>&1 || true
    pkill -f "${cleanup_root}/MediaCrawler/.venv/bin/uvicorn api.main:app" >/dev/null 2>&1 || true
  done
  pkill -f "pnpm --filter ./apps/backend run dev" >/dev/null 2>&1 || true
  pkill -f "pnpm --filter ./apps/orchestrator run dev" >/dev/null 2>&1 || true
  pkill -f "temporal server start-dev" >/dev/null 2>&1 || true
fi

if [[ "${STOP_DOCKER_INFRA}" == "1" || ("${USE_LOCAL_TEMPORAL}" != "1" && "${SKIP_DOCKER_INFRA}" != "1") ]]; then
  echo "[STEP] Stopping Docker compose services"
  if command -v docker >/dev/null 2>&1; then
    if docker compose -f "${ROOT_DIR}/docker-compose.dev.yaml" down; then
      :
    else
      echo "[WARN] WSL docker compose down failed. Trying Windows docker.exe fallback..."
      DOCKER_EXE="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
      if [[ ! -f "${DOCKER_EXE}" ]]; then
        echo "[WARN] docker.exe not found, skipped compose down fallback"
      elif fallback_compose="$(resolve_fallback_compose_file)"; then
        fallback_compose_win="$(wslpath -w "${fallback_compose}")"
        "${DOCKER_EXE}" compose -f "${fallback_compose_win}" down || echo "[WARN] docker.exe compose down failed"
      else
        echo "[WARN] Fallback compose file not found, skipped compose down fallback"
      fi
    fi
  else
    echo "[WARN] docker not found, skipped compose down"
  fi
else
  echo "[SKIP] Docker infra stop skipped (local Temporal mode)"
fi

echo "[DONE] Dev stack stopped."
