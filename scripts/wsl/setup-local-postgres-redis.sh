#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"

LOCAL_POSTGRES_HOST="${LOCAL_POSTGRES_HOST:-127.0.0.1}"
LOCAL_POSTGRES_PORT="${LOCAL_POSTGRES_PORT:-5432}"
LOCAL_POSTGRES_DB="${LOCAL_POSTGRES_DB:-postiz-db-local}"
LOCAL_POSTGRES_USER="${LOCAL_POSTGRES_USER:-postiz-local}"
LOCAL_POSTGRES_PASSWORD="${LOCAL_POSTGRES_PASSWORD:-postiz-local-pwd}"
LOCAL_REDIS_HOST="${LOCAL_REDIS_HOST:-127.0.0.1}"
LOCAL_REDIS_PORT="${LOCAL_REDIS_PORT:-6379}"

run_with_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_postgres() {
  if [[ "${EUID}" -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    sudo -u postgres "$@"
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return
  fi
  if [[ -f "${ENV_EXAMPLE_FILE}" ]]; then
    cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    echo "[INFO] Created .env from .env.example"
    return
  fi
  echo "[ERROR] .env and .env.example are both missing"
  exit 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped_value
  escaped_value="$(printf '%s' "${value}" | sed 's/[&|]/\\&/g')"

  if grep -qE "^${key}=" "${ENV_FILE}"; then
    sed -i -E "s|^${key}=.*|${key}=\"${escaped_value}\"|" "${ENV_FILE}"
  else
    echo "${key}=\"${value}\"" >>"${ENV_FILE}"
  fi
}

start_service() {
  local service_name="$1"
  if has_cmd service; then
    if run_with_sudo service "${service_name}" start; then
      return 0
    fi
  fi
  if has_cmd systemctl && systemctl list-unit-files >/dev/null 2>&1; then
    run_with_sudo systemctl start "${service_name}"
    return 0
  fi
  echo "[ERROR] Failed to start service: ${service_name}"
  exit 1
}

stop_docker_data_services() {
  local docker_bin=""
  local docker_exe="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  local docker_exe_short="/mnt/c/Progra~1/Docker/Docker/resources/bin/docker.exe"

  if has_cmd docker; then
    docker_bin="docker"
  elif [[ -f "${docker_exe}" ]]; then
    docker_bin="${docker_exe}"
  elif [[ -f "${docker_exe_short}" ]]; then
    docker_bin="${docker_exe_short}"
  fi

  if [[ -z "${docker_bin}" ]]; then
    return 0
  fi

  echo "[STEP] Stopping Docker Postgres/Redis containers (if any)"
  "${docker_bin}" rm -f postiz-postgres postiz-redis postiz-pg-admin postiz-redisinsight >/dev/null 2>&1 || true
}

install_packages() {
  echo "[STEP] Installing PostgreSQL and Redis packages"
  run_with_sudo apt-get update
  run_with_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    postgresql \
    postgresql-contrib \
    redis-server \
    redis-tools
}

ensure_postgres_user_and_db() {
  local user_escaped password_escaped db_escaped role_exists db_exists

  user_escaped="${LOCAL_POSTGRES_USER//\'/\'\'}"
  password_escaped="${LOCAL_POSTGRES_PASSWORD//\'/\'\'}"
  db_escaped="${LOCAL_POSTGRES_DB//\'/\'\'}"

  role_exists="$(
    run_as_postgres psql -tAc \
      "SELECT 1 FROM pg_roles WHERE rolname='${user_escaped}'" | tr -d '[:space:]'
  )"
  if [[ "${role_exists}" != "1" ]]; then
    run_as_postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE ROLE \"${LOCAL_POSTGRES_USER}\" WITH LOGIN PASSWORD '${password_escaped}';"
    echo "[OK] Created PostgreSQL role ${LOCAL_POSTGRES_USER}"
  else
    echo "[OK] PostgreSQL role already exists: ${LOCAL_POSTGRES_USER}"
  fi

  run_as_postgres psql -v ON_ERROR_STOP=1 -c \
    "ALTER ROLE \"${LOCAL_POSTGRES_USER}\" WITH LOGIN PASSWORD '${password_escaped}';"

  db_exists="$(
    run_as_postgres psql -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${db_escaped}'" | tr -d '[:space:]'
  )"
  if [[ "${db_exists}" != "1" ]]; then
    run_as_postgres createdb -O "${LOCAL_POSTGRES_USER}" "${LOCAL_POSTGRES_DB}"
    echo "[OK] Created PostgreSQL database ${LOCAL_POSTGRES_DB}"
  else
    echo "[OK] PostgreSQL database already exists: ${LOCAL_POSTGRES_DB}"
    run_as_postgres psql -v ON_ERROR_STOP=1 -c \
      "ALTER DATABASE \"${LOCAL_POSTGRES_DB}\" OWNER TO \"${LOCAL_POSTGRES_USER}\";"
  fi
}

verify_local_services() {
  echo "[STEP] Verifying local PostgreSQL/Redis"
  PGPASSWORD="${LOCAL_POSTGRES_PASSWORD}" \
    pg_isready -h "${LOCAL_POSTGRES_HOST}" -p "${LOCAL_POSTGRES_PORT}" \
    -U "${LOCAL_POSTGRES_USER}" -d "${LOCAL_POSTGRES_DB}" >/dev/null
  echo "[OK] PostgreSQL is reachable at ${LOCAL_POSTGRES_HOST}:${LOCAL_POSTGRES_PORT}"

  redis-cli -h "${LOCAL_REDIS_HOST}" -p "${LOCAL_REDIS_PORT}" ping | grep -q '^PONG$'
  echo "[OK] Redis is reachable at ${LOCAL_REDIS_HOST}:${LOCAL_REDIS_PORT}"
}

sync_env() {
  echo "[STEP] Updating ${ENV_FILE}"
  cp "${ENV_FILE}" "${ENV_FILE}.bak.local.$(date +%Y%m%d%H%M%S)"
  set_env_value "DATABASE_URL" "postgresql://${LOCAL_POSTGRES_USER}:${LOCAL_POSTGRES_PASSWORD}@${LOCAL_POSTGRES_HOST}:${LOCAL_POSTGRES_PORT}/${LOCAL_POSTGRES_DB}"
  set_env_value "REDIS_URL" "redis://${LOCAL_REDIS_HOST}:${LOCAL_REDIS_PORT}"
}

main() {
  ensure_env_file
  install_packages
  stop_docker_data_services

  echo "[STEP] Starting local services"
  start_service postgresql
  start_service redis-server

  ensure_postgres_user_and_db
  sync_env
  verify_local_services

  echo "[DONE] Local PostgreSQL/Redis setup completed"
  echo "[INFO] Next run:"
  echo "       USE_LOCAL_POSTGRES_REDIS=1 ./scripts/wsl/start-dev.sh"
}

main "$@"
