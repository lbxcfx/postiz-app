#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/.runtime/logs"
PID_DIR="${ROOT_DIR}/.runtime/pids"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

pkill -9 -f 'apps/backend' >/dev/null 2>&1 || true

nohup bash -lc "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; nvm use 22 --silent >/dev/null 2>&1; cd '${ROOT_DIR}' && node -r dotenv/config -r @swc-node/register -r tsconfig-paths/register apps/backend/src/main.ts dotenv_config_path=.env" >"${LOG_DIR}/backend.log" 2>&1 < /dev/null &
echo $! >"${PID_DIR}/backend.pid"

echo "[DONE] backend started with swc register"
