#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USE_LOCAL_TEMPORAL="${USE_LOCAL_TEMPORAL:-1}"
cd "$ROOT_DIR"

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

echo "[STEP] Toolchain"
for cmd in node pnpm curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "[OK] $cmd -> $(command -v "$cmd")"
  else
    echo "[FAIL] missing command: $cmd"
    exit 1
  fi
done

if [[ "${USE_LOCAL_TEMPORAL}" == "1" ]]; then
  if command -v temporal >/dev/null 2>&1; then
    echo "[OK] temporal -> $(command -v temporal)"
  else
    echo "[FAIL] missing command: temporal"
    echo "       run: ./scripts/wsl/setup-local-temporal.sh"
    exit 1
  fi
else
  if command -v docker >/dev/null 2>&1; then
    echo "[OK] docker -> $(command -v docker)"
  else
    echo "[FAIL] missing command: docker"
    exit 1
  fi
fi

echo "[STEP] Environment file"
if [[ -f ".env" ]]; then
  echo "[OK] .env exists"
else
  echo "[FAIL] .env missing (copy from .env.example)"
  exit 1
fi

echo "[STEP] Required environment keys"
required_keys=(
  "DATABASE_URL"
  "REDIS_URL"
  "TEMPORAL_ADDRESS"
  "MEDIACRAWLER_API_URL"
  "CHINA_SOCIAL_SERVICE_URL"
)
for key in "${required_keys[@]}"; do
  if grep -qE "^${key}=" .env; then
    echo "[OK] ${key}"
  else
    echo "[FAIL] ${key} is not configured in .env"
    exit 1
  fi
done

echo "[STEP] WSL host compatibility checks"
if grep -qE '^DATABASE_URL=.*host\.docker\.internal' .env; then
  echo "[FAIL] DATABASE_URL uses host.docker.internal; use 127.0.0.1 in WSL"
  exit 1
fi
if grep -qE '^REDIS_URL=.*host\.docker\.internal' .env; then
  echo "[FAIL] REDIS_URL uses host.docker.internal; use 127.0.0.1 in WSL"
  exit 1
fi
echo "[OK] DATABASE_URL/REDIS_URL use WSL-safe host"

if [[ "${USE_LOCAL_TEMPORAL}" == "1" ]]; then
  echo "[STEP] Local Temporal CLI"
  temporal --version
else
  echo "[STEP] Docker services"
  if docker compose -f docker-compose.dev.yaml ps >/dev/null 2>&1; then
    docker compose -f docker-compose.dev.yaml ps
  else
    echo "[WARN] WSL docker compose ps failed. Trying Windows docker.exe fallback..."
    docker_exe="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
    if [[ ! -f "${docker_exe}" ]]; then
      echo "[FAIL] docker compose check failed and docker.exe not found"
      exit 1
    fi
    if ! fallback_compose="$(resolve_fallback_compose_file)"; then
      echo "[FAIL] docker compose check failed and fallback compose file not found"
      exit 1
    fi
    fallback_compose_win="$(wslpath -w "${fallback_compose}")"
    "${docker_exe}" compose -f "${fallback_compose_win}" ps
  fi
fi

echo "[DONE] preflight check passed"
