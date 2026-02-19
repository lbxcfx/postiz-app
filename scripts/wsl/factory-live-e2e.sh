#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[FAIL] 请在 WSL Ubuntu/Linux 环境执行：./scripts/wsl/factory-live-e2e.sh"
  exit 1
fi

if [[ "${FACTORY_LIVE_E2E:-0}" != "1" ]]; then
  echo "[SKIP] FACTORY_LIVE_E2E!=1，跳过联机 E2E。"
  echo "       如需执行：export FACTORY_LIVE_E2E=1 AUTH_TOKEN=... [SHOWORG=...]"
  exit 0
fi

echo "[INFO] report dir: ${FACTORY_E2E_REPORT_DIR:-reports}"
node ./scripts/wsl/factory-live-e2e.js --live
