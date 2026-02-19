#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "${NVM_DIR}/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

# Ensure local bin is in PATH (and restore /usr/bin if needed)
export PATH="$HOME/.local/bin:$PATH:/usr/bin"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_DIR="${RUNTIME_DIR}/pids"
USE_LOCAL_POSTGRES_REDIS="${USE_LOCAL_POSTGRES_REDIS:-1}"
USE_LOCAL_TEMPORAL="${USE_LOCAL_TEMPORAL:-1}"
SKIP_DOCKER_INFRA="${SKIP_DOCKER_INFRA:-0}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8080}"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

get_node_major() {
  local version
  version="$(node -v 2>/dev/null || true)"
  version="${version#v}"
  echo "${version%%.*}"
}

start_proc() {
  local name="$1"
  local cmd="$2"
  local ready_url="${3:-}"
  local required="${4:-1}"
  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"

  if [[ -f "${pid_file}" ]]; then
    local old_pid
    old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
      echo "[SKIP] ${name} already running (pid=${old_pid})"
      return
    fi
    rm -f "${pid_file}"
  fi

  echo "[START] ${name}"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bash -lc "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; export NODE_OPTIONS=\"${NODE_OPTIONS:---max-old-space-size=4096}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; nvm use 22 --silent 2>/dev/null; cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  else
    nohup bash -lc "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; export NODE_OPTIONS=\"${NODE_OPTIONS:---max-old-space-size=4096}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; nvm use 22 --silent 2>/dev/null; cd '${ROOT_DIR}' && ${cmd}" >"${log_file}" 2>&1 < /dev/null &
  fi
  local new_pid="$!"
  echo "${new_pid}" >"${pid_file}"

  sleep 1
  if ! kill -0 "${new_pid}" >/dev/null 2>&1; then
    rm -f "${pid_file}"
    if [[ -n "${ready_url}" ]] && curl -fsS --max-time 3 "${ready_url}" >/dev/null 2>&1; then
      echo "[SKIP] ${name} already served at ${ready_url}"
      return 0
    fi
    if [[ "${required}" == "1" ]]; then
      echo "[ERROR] ${name} exited immediately. Check log: ${log_file}"
      return 1
    fi
    echo "[WARN] ${name} exited immediately. Check log: ${log_file}"
    return 0
  fi
}

stop_proc() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if [[ ! -f "${pid_file}" ]]; then
    return 0
  fi

  local old_pid
  old_pid="$(cat "${pid_file}" 2>/dev/null || true)"
  rm -f "${pid_file}"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
    kill "${old_pid}" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "${old_pid}" >/dev/null 2>&1 || true
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] Missing command: $1"
    exit 1
  }
}

check_tcp_port() {
  local host="$1"
  local port="$2"
  (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

resolve_data_plane_targets() {
  local env_file="${ROOT_DIR}/.env"
  local db_host="127.0.0.1"
  local db_port="5432"
  local redis_host="127.0.0.1"
  local redis_port="6379"

  if [[ -f "${env_file}" ]]; then
    local db_line db_url redis_line redis_url redis_no_scheme redis_host_port
    db_line="$(grep -E '^DATABASE_URL=' "${env_file}" | head -n 1 || true)"
    db_url="${db_line#DATABASE_URL=}"
    db_url="${db_url%\"}"
    db_url="${db_url#\"}"
    if [[ "${db_url}" =~ @([^:/]+):([0-9]+) ]]; then
      db_host="${BASH_REMATCH[1]}"
      db_port="${BASH_REMATCH[2]}"
    fi

    redis_line="$(grep -E '^REDIS_URL=' "${env_file}" | head -n 1 || true)"
    redis_url="${redis_line#REDIS_URL=}"
    redis_url="${redis_url%\"}"
    redis_url="${redis_url#\"}"
    redis_no_scheme="${redis_url#redis://}"
    redis_host_port="${redis_no_scheme#*@}"
    if [[ "${redis_host_port}" == *:* ]]; then
      redis_host="${redis_host_port%%:*}"
      redis_port="${redis_host_port##*:}"
      redis_port="${redis_port%%/*}"
    fi
  fi

  echo "${db_host}:${db_port}:${redis_host}:${redis_port}"
}

resolve_temporal_target() {
  local default_host="127.0.0.1"
  local default_port="7233"
  local env_file="${ROOT_DIR}/.env"
  local temporal_address

  temporal_address="${TEMPORAL_ADDRESS:-}"
  if [[ -z "${temporal_address}" && -f "${env_file}" ]]; then
    temporal_address="$(grep -E '^TEMPORAL_ADDRESS=' "${env_file}" | head -n 1 | cut -d'=' -f2- | tr -d '"' || true)"
  fi

  if [[ "${temporal_address}" =~ ^([^:/]+):([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  else
    echo "${default_host}:${default_port}"
  fi
}

resolve_temporal_namespace() {
  local env_file="${ROOT_DIR}/.env"
  local namespace

  namespace="${TEMPORAL_NAMESPACE:-}"
  if [[ -z "${namespace}" && -f "${env_file}" ]]; then
    namespace="$(grep -E '^TEMPORAL_NAMESPACE=' "${env_file}" | head -n 1 | cut -d'=' -f2- | tr -d '"' || true)"
  fi
  if [[ -z "${namespace}" ]]; then
    namespace="default"
  fi
  echo "${namespace}"
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local retries="${3:-30}"
  local sleep_seconds="${4:-2}"
  local attempt=1

  while [[ "${attempt}" -le "${retries}" ]]; do
    if check_tcp_port "${host}" "${port}"; then
      return 0
    fi
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

start_local_temporal() {
  local temporal_target temporal_host temporal_port
  local temporal_namespace temporal_db temporal_cmd

  require_cmd temporal

  temporal_target="$(resolve_temporal_target)"
  temporal_host="${temporal_target%%:*}"
  temporal_port="${temporal_target##*:}"
  temporal_namespace="$(resolve_temporal_namespace)"
  temporal_db="${RUNTIME_DIR}/temporal/temporal-dev.db"
  mkdir -p "$(dirname "${temporal_db}")"

  temporal_cmd="temporal server start-dev --ip ${temporal_host} --port ${temporal_port} --ui-ip 127.0.0.1 --ui-port ${TEMPORAL_UI_PORT} --db-filename ${temporal_db}"
  if [[ "${temporal_namespace}" != "default" ]]; then
    temporal_cmd="${temporal_cmd} --namespace ${temporal_namespace}"
  fi

  start_proc "temporal" "${temporal_cmd}" "http://127.0.0.1:${TEMPORAL_UI_PORT}" "1"
  if ! wait_for_tcp "${temporal_host}" "${temporal_port}" 45 2; then
    echo "[ERROR] Local Temporal not reachable at ${temporal_host}:${temporal_port}"
    echo "        check log: ${LOG_DIR}/temporal.log"
    exit 1
  fi
  if ! wait_for_http "http://127.0.0.1:${TEMPORAL_UI_PORT}" 30 2; then
    echo "[WARN] Temporal UI is not ready at http://127.0.0.1:${TEMPORAL_UI_PORT}"
  fi
}

ensure_local_data_services() {
  if [[ "${USE_LOCAL_POSTGRES_REDIS}" != "1" ]]; then
    return 0
  fi

  local targets db_host db_port redis_host redis_port
  targets="$(resolve_data_plane_targets)"
  db_host="${targets%%:*}"
  targets="${targets#*:}"
  db_port="${targets%%:*}"
  targets="${targets#*:}"
  redis_host="${targets%%:*}"
  redis_port="${targets##*:}"

  echo "[STEP] Checking local Postgres/Redis services"
  if ! check_tcp_port "${db_host}" "${db_port}"; then
    echo "[ERROR] Local Postgres is not reachable at ${db_host}:${db_port}"
    echo "        run: ./scripts/wsl/setup-local-postgres-redis.sh"
    exit 1
  fi
  if ! check_tcp_port "${redis_host}" "${redis_port}"; then
    echo "[ERROR] Local Redis is not reachable at ${redis_host}:${redis_port}"
    echo "        run: ./scripts/wsl/setup-local-postgres-redis.sh"
    exit 1
  fi
  echo "[OK] Local Postgres/Redis TCP checks passed"
}

wait_for_http() {
  local url="$1"
  local retries="${2:-20}"
  local sleep_seconds="${3:-2}"
  local attempt=1
  while [[ "${attempt}" -le "${retries}" ]]; do
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

start_infra_services() {
  local compose_file="${ROOT_DIR}/docker-compose.dev.yaml"
  local compose_services=()

  if [[ "${USE_LOCAL_TEMPORAL}" == "1" ]]; then
    echo "[STEP] Starting local Temporal dev server"
    start_local_temporal
    return 0
  fi

  if [[ "${SKIP_DOCKER_INFRA}" == "1" ]]; then
    echo "[SKIP] SKIP_DOCKER_INFRA=1, skip docker compose startup"
    return 0
  fi

  if [[ "${USE_LOCAL_POSTGRES_REDIS}" == "1" ]]; then
    echo "[STEP] Starting Temporal infra with Docker Compose (local Postgres/Redis mode)"
    compose_services=(
      temporal-postgresql
      temporal-elasticsearch
      temporal
      temporal-admin-tools
      temporal-ui
    )
  else
    echo "[STEP] Starting infra services with Docker Compose"
  fi

  if docker compose -f "${compose_file}" up -d "${compose_services[@]}"; then
    return 0
  fi

  echo "[WARN] WSL docker compose failed. Trying Windows docker.exe fallback..."
  local docker_exe="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  local fallback_compose=""
  local fallback_compose_win=""

  if [[ ! -f "${docker_exe}" ]]; then
    echo "[ERROR] docker.exe not found for fallback: ${docker_exe}"
    return 1
  fi
  if ! fallback_compose="$(resolve_fallback_compose_file)"; then
    echo "[ERROR] Fallback compose file not found."
    echo "        Tried: WIN_FALLBACK_COMPOSE_FILE, WIN_FALLBACK_ROOT/docker-compose.dev.yaml,"
    echo "               ${ROOT_DIR}/docker-compose.dev.yaml (when under /mnt/*), /mnt/f/postiz-app/docker-compose.dev.yaml"
    return 1
  fi

  fallback_compose_win="$(wslpath -w "${fallback_compose}")"
  echo "[INFO] Fallback compose file: ${fallback_compose}"
  "${docker_exe}" compose -f "${fallback_compose_win}" up -d "${compose_services[@]}"
}

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

normalize_env_for_wsl() {
  local env_file="${ROOT_DIR}/.env"
  if [[ "${SKIP_ENV_AUTO_FIX:-0}" == "1" ]]; then
    echo "[SKIP] SKIP_ENV_AUTO_FIX=1, skip .env normalization"
    return
  fi
  if [[ ! -f "${env_file}" ]]; then
    return
  fi

  can_connect_tcp() {
    local host="$1"
    local port="$2"
    (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1
  }

  pick_reachable_host() {
    local current_host="$1"
    local port="$2"
    local candidate
    local seen="|"
    for candidate in "${current_host}" "127.0.0.1" "host.docker.internal"; do
      if [[ -z "${candidate}" ]]; then
        continue
      fi
      if [[ "${seen}" == *"|${candidate}|"* ]]; then
        continue
      fi
      seen="${seen}${candidate}|"
      if can_connect_tcp "${candidate}" "${port}"; then
        echo "${candidate}"
        return 0
      fi
    done
    echo "${current_host}"
    return 0
  }

  local db_line db_url db_host db_port
  db_line="$(grep -E '^DATABASE_URL=' "${env_file}" | head -n 1 || true)"
  db_url="${db_line#DATABASE_URL=}"
  db_url="${db_url%\"}"
  db_url="${db_url#\"}"
  if [[ "${db_url}" =~ @([^:/]+):([0-9]+) ]]; then
    db_host="${BASH_REMATCH[1]}"
    db_port="${BASH_REMATCH[2]}"
  fi

  local redis_line redis_url redis_host redis_port
  redis_line="$(grep -E '^REDIS_URL=' "${env_file}" | head -n 1 || true)"
  redis_url="${redis_line#REDIS_URL=}"
  redis_url="${redis_url%\"}"
  redis_url="${redis_url#\"}"
  if [[ "${redis_url}" =~ redis://([^:/]+):([0-9]+) ]]; then
    redis_host="${BASH_REMATCH[1]}"
    redis_port="${BASH_REMATCH[2]}"
  fi

  local changed=0
  if [[ -n "${db_host:-}" && -n "${db_port:-}" ]]; then
    local db_target_host
    db_target_host="$(pick_reachable_host "${db_host}" "${db_port}")"
    if [[ -n "${db_target_host}" && "${db_target_host}" != "${db_host}" ]]; then
      cp "${env_file}" "${env_file}.bak.wsl" >/dev/null 2>&1 || true
      sed -i -E "/^DATABASE_URL=/ s#(@)[^:/\"]+(:${db_port})#\\1${db_target_host}\\2#" "${env_file}"
      echo "[FIX] DATABASE_URL host: ${db_host} -> ${db_target_host}"
      changed=1
    fi
  fi

  if [[ -n "${redis_host:-}" && -n "${redis_port:-}" ]]; then
    local redis_target_host
    redis_target_host="$(pick_reachable_host "${redis_host}" "${redis_port}")"
    if [[ -n "${redis_target_host}" && "${redis_target_host}" != "${redis_host}" ]]; then
      cp "${env_file}" "${env_file}.bak.wsl" >/dev/null 2>&1 || true
      sed -i -E "/^REDIS_URL=/ s#(redis://)[^:/\"]+(:${redis_port})#\\1${redis_target_host}\\2#" "${env_file}"
      echo "[FIX] REDIS_URL host: ${redis_host} -> ${redis_target_host}"
      changed=1
    fi
  fi

  if [[ "${changed}" == "1" ]]; then
    echo "[INFO] Backup: ${env_file}.bak.wsl"
  fi
}

verify_data_plane() {
  echo "[STEP] Verifying Postgres/Redis connectivity"
  local retries="${DATA_PLANE_RETRIES:-20}"
  local sleep_seconds="${DATA_PLANE_RETRY_INTERVAL_SECONDS:-3}"
  local attempt=1
  while [[ "${attempt}" -le "${retries}" ]]; do
    if (cd "${ROOT_DIR}" && node scripts/wsl/test-prisma-connect.js >/dev/null 2>&1) && \
       (cd "${ROOT_DIR}" && node test-redis.js >/dev/null 2>&1); then
      echo "[OK] Postgres and Redis are reachable from WSL Node runtime"
      return 0
    fi
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done

  echo "[ERROR] Prisma/Redis checks failed after ${retries} attempts."
  echo "        quick check: node scripts/wsl/test-prisma-connect.js"
  echo "        quick check: node test-redis.js"
  exit 1
}

ensure_prisma_schema() {
  echo "[STEP] Syncing Prisma schema to database"
  if (cd "${ROOT_DIR}" && pnpm run prisma-db-push >/dev/null 2>&1); then
    echo "[OK] Prisma schema is in sync"
    return 0
  fi

  echo "[ERROR] Failed to sync Prisma schema."
  echo "        run manually: pnpm run prisma-db-push"
  exit 1
}

# Auto-fix docker if missing (common in WSL/nvm environments)
if [[ "${USE_LOCAL_TEMPORAL}" != "1" && "${SKIP_DOCKER_INFRA}" != "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_EXE="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
    if [[ ! -f "$DOCKER_EXE" ]]; then
      DOCKER_EXE="/mnt/c/Progra~1/Docker/Docker/resources/bin/docker.exe"
    fi
    if [[ -f "$DOCKER_EXE" ]]; then
      mkdir -p "$HOME/.local/bin"
      ln -sf "$DOCKER_EXE" "$HOME/.local/bin/docker"
      # echo "[INFO] Symlinked docker.exe to $HOME/.local/bin/docker"
    fi
  fi
fi

if [[ "${USE_LOCAL_TEMPORAL}" != "1" && "${SKIP_DOCKER_INFRA}" != "1" ]]; then
  require_cmd docker
fi
if [[ "${USE_LOCAL_TEMPORAL}" == "1" ]]; then
  require_cmd temporal
fi
require_cmd pnpm
require_cmd python3
require_cmd node
require_cmd curl

if [[ "${USE_LOCAL_TEMPORAL}" != "1" && "${SKIP_DOCKER_INFRA}" != "1" ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "[ERROR] Docker daemon not ready. Start Docker Desktop first."
    exit 1
  fi
fi

start_infra_services
normalize_env_for_wsl
ensure_local_data_services

verify_data_plane
ensure_prisma_schema

echo "[STEP] Starting app services"
NODE_MAJOR="$(get_node_major)"
BACKEND_DIST="apps/backend/dist/apps/backend/src/main.js"
ORCHESTRATOR_DIST="apps/orchestrator/dist/apps/orchestrator/src/main.js"
FORCE_WSL_DEV="${FORCE_WSL_DEV:-0}"
FORCE_WSL_DIST="${FORCE_WSL_DIST:-0}"

if [[ "${FORCE_WSL_DEV}" == "1" ]]; then
  echo "[INFO] FORCE_WSL_DEV=1, using pnpm dev for backend/orchestrator"
  start_proc "backend" "pnpm --filter ./apps/backend run dev" "http://localhost:3000/docs" "0"
  start_proc "orchestrator" "pnpm --filter ./apps/orchestrator run dev"
elif [[ "${FORCE_WSL_DIST}" == "1" ]]; then
  echo "[INFO] FORCE_WSL_DIST=1, using dist runtime for backend/orchestrator"
  if [[ ! -f "${BACKEND_DIST}" || ! -f "${ORCHESTRATOR_DIST}" ]]; then
    echo "[ERROR] dist artifacts missing. Run build first:"
    echo "        pnpm --filter ./apps/backend run build"
    echo "        pnpm --filter ./apps/orchestrator run build"
    exit 1
  fi
  start_proc "backend" "node -r dotenv/config ${BACKEND_DIST} dotenv_config_path=.env" "http://localhost:3000/docs" "0"
  start_proc "orchestrator" "node -r dotenv/config ${ORCHESTRATOR_DIST} dotenv_config_path=.env"
elif [[ -n "${NODE_MAJOR}" && "${NODE_MAJOR}" -ge 22 ]]; then
  start_proc "backend" "pnpm --filter ./apps/backend run dev" "http://localhost:3000/docs" "0"
  start_proc "orchestrator" "pnpm --filter ./apps/orchestrator run dev"
else
  echo "[WARN] WSL Node.js version < 22, fallback to WSL Node dist runtime"
  if [[ ! -f "${BACKEND_DIST}" || ! -f "${ORCHESTRATOR_DIST}" ]]; then
    echo "[ERROR] dist artifacts missing. Run build first:"
    echo "        pnpm --filter ./apps/backend run build"
    echo "        pnpm --filter ./apps/orchestrator run build"
    exit 1
  fi
  start_proc "backend" "node -r dotenv/config ${BACKEND_DIST} dotenv_config_path=.env" "http://localhost:3000/docs" "0"
  start_proc "orchestrator" "node -r dotenv/config ${ORCHESTRATOR_DIST} dotenv_config_path=.env"
fi

if ! wait_for_http "http://localhost:3000/docs" 20 2; then
  echo "[WARN] backend dev watch mode not ready, fallback to ts-node runtime"
  stop_proc "backend"
  start_proc "backend" "pnpm --filter ./apps/backend exec nest start --entryFile=./apps/backend/src/main" "http://localhost:3000/docs"
fi

start_proc "frontend" "pnpm --filter ./apps/frontend run dev" "http://localhost:4200"
start_proc "social_auto_upload" "cd social-auto-upload-main/social-auto-upload-main && uv run python3 sau_backend.py" "http://localhost:5409/docs" "0"
start_proc "mediacrawler" "cd MediaCrawler && (if [ -d .venv ]; then . .venv/bin/activate; elif [ -d ~/post ]; then . ~/post/bin/activate; fi; python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload)" "http://localhost:8081/docs" "0"

echo "[DONE] Dev stack startup triggered."
echo "[INFO] Logs: ${LOG_DIR}"
echo "[INFO] PIDs: ${PID_DIR}"
