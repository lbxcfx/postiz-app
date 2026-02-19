#!/usr/bin/env bash
set -euo pipefail

MAX_WAIT_SECONDS="${HEALTH_MAX_WAIT_SECONDS:-90}"
INTERVAL_SECONDS="${HEALTH_RETRY_INTERVAL_SECONDS:-3}"
HTTP_TIMEOUT_SECONDS="${HEALTH_HTTP_TIMEOUT_SECONDS:-6}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_SOCIAL_AUTO_UPLOAD="${CHECK_SOCIAL_AUTO_UPLOAD:-0}"
USE_LOCAL_POSTGRES_REDIS="${USE_LOCAL_POSTGRES_REDIS:-1}"
SKIP_TEMPORAL_CHECK="${SKIP_TEMPORAL_CHECK:-0}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8080}"

failures=0

wait_for_http() {
  local name="$1"
  local url="$2"
  local elapsed=0
  while (( elapsed < MAX_WAIT_SECONDS )); do
    if curl -fsS --max-time "${HTTP_TIMEOUT_SECONDS}" "$url" >/dev/null 2>&1; then
      echo "[OK] ${name} -> ${url}"
      return 0
    fi
    sleep "${INTERVAL_SECONDS}"
    elapsed=$((elapsed + INTERVAL_SECONDS))
  done
  echo "[FAIL] ${name} -> ${url} (timeout: ${MAX_WAIT_SECONDS}s)"
  return 1
}

check_tcp_port() {
  local name="$1"
  local host="$2"
  local port="$3"
  if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
    echo "[OK] ${name} tcp://${host}:${port}"
    return 0
  fi
  echo "[FAIL] ${name} tcp://${host}:${port}"
  return 1
}

resolve_postgres_target() {
  local default_host="127.0.0.1"
  local default_port="5432"
  local env_file="${ROOT_DIR}/.env"
  local db_url

  if [[ ! -f "${env_file}" ]]; then
    echo "${default_host}:${default_port}"
    return
  fi

  db_url="$(grep -E '^DATABASE_URL=' "${env_file}" | head -n 1 | cut -d'=' -f2- | tr -d '"' || true)"
  if [[ "${db_url}" =~ @([^:/]+):([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  else
    echo "${default_host}:${default_port}"
  fi
}

resolve_redis_target() {
  local default_host="127.0.0.1"
  local default_port="6379"
  local env_file="${ROOT_DIR}/.env"
  local redis_url redis_no_scheme redis_host_port redis_host redis_port

  if [[ ! -f "${env_file}" ]]; then
    echo "${default_host}:${default_port}"
    return
  fi

  redis_url="$(grep -E '^REDIS_URL=' "${env_file}" | head -n 1 | cut -d'=' -f2- | tr -d '"' || true)"
  redis_no_scheme="${redis_url#redis://}"
  redis_host_port="${redis_no_scheme#*@}"
  if [[ "${redis_host_port}" == *:* ]]; then
    redis_host="${redis_host_port%%:*}"
    redis_port="${redis_host_port##*:}"
    redis_port="${redis_port%%/*}"
    echo "${redis_host}:${redis_port}"
  else
    echo "${default_host}:${default_port}"
  fi
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

resolve_temporal_ui_port() {
  local env_file="${ROOT_DIR}/.env"
  local configured="${TEMPORAL_UI_PORT}"

  if [[ -f "${env_file}" ]]; then
    local line value
    line="$(grep -E '^TEMPORAL_UI_PORT=' "${env_file}" | head -n 1 || true)"
    value="${line#TEMPORAL_UI_PORT=}"
    value="${value%\"}"
    value="${value#\"}"
    if [[ "${value}" =~ ^[0-9]+$ ]]; then
      configured="${value}"
    fi
  fi
  echo "${configured}"
}

echo "[STEP] HTTP readiness checks"
wait_for_http "frontend" "http://localhost:4200" || failures=$((failures + 1))
wait_for_http "backend" "http://localhost:3000/docs" || failures=$((failures + 1))
wait_for_http "mediacrawler" "http://localhost:8081/docs" || failures=$((failures + 1))
if [[ "${CHECK_SOCIAL_AUTO_UPLOAD}" == "1" ]]; then
  wait_for_http "social-auto-upload" "http://localhost:5409/docs" || failures=$((failures + 1))
else
  echo "[SKIP] social-auto-upload check disabled (set CHECK_SOCIAL_AUTO_UPLOAD=1 to enable)"
fi
if [[ "${SKIP_TEMPORAL_CHECK}" == "1" ]]; then
  echo "[SKIP] temporal-ui check disabled (set SKIP_TEMPORAL_CHECK=0 to enable)"
else
  TEMPORAL_UI_PORT_RESOLVED="$(resolve_temporal_ui_port)"
  wait_for_http "temporal-ui" "http://127.0.0.1:${TEMPORAL_UI_PORT_RESOLVED}" || failures=$((failures + 1))
fi
if [[ "${USE_LOCAL_POSTGRES_REDIS}" == "1" ]]; then
  echo "[SKIP] pgadmin check skipped in local Postgres/Redis mode"
else
  wait_for_http "pgadmin" "http://localhost:8082" || failures=$((failures + 1))
fi

echo "[STEP] TCP readiness checks"
if [[ "${SKIP_TEMPORAL_CHECK}" == "1" ]]; then
  echo "[SKIP] temporal tcp check disabled (set SKIP_TEMPORAL_CHECK=0 to enable)"
else
  TEMPORAL_TARGET="$(resolve_temporal_target)"
  TEMPORAL_HOST="${TEMPORAL_TARGET%%:*}"
  TEMPORAL_PORT="${TEMPORAL_TARGET##*:}"
  check_tcp_port "temporal" "${TEMPORAL_HOST}" "${TEMPORAL_PORT}" || failures=$((failures + 1))
fi
POSTGRES_TARGET="$(resolve_postgres_target)"
POSTGRES_HOST="${POSTGRES_TARGET%%:*}"
POSTGRES_PORT="${POSTGRES_TARGET##*:}"
check_tcp_port "postgres" "${POSTGRES_HOST}" "${POSTGRES_PORT}" || failures=$((failures + 1))
REDIS_TARGET="$(resolve_redis_target)"
REDIS_HOST="${REDIS_TARGET%%:*}"
REDIS_PORT="${REDIS_TARGET##*:}"
check_tcp_port "redis" "${REDIS_HOST}" "${REDIS_PORT}" || failures=$((failures + 1))

# echo "[STEP] Container checks"
# docker compose -f docker-compose.dev.yaml ps # Skip since running natively or partially

if (( failures > 0 )); then
  echo "[FAIL] health check failed (${failures} checks not ready)"
  exit 1
fi

echo "[DONE] health check passed"
