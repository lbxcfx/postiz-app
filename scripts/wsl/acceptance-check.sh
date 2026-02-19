#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[FAIL] 请在 WSL Ubuntu/Linux 环境执行：./scripts/wsl/acceptance-check.sh"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[STEP] 1/6 Preflight"
./scripts/wsl/preflight-check.sh

echo "[STEP] 2/6 Runtime health"
./scripts/wsl/health-check.sh

echo "[STEP] 3/6 Frontend build verification"
pnpm --filter ./apps/frontend run build

echo "[STEP] 4/6 Factory chain checks"
./scripts/wsl/factory-chain-check.sh

echo "[STEP] 5/6 Full-stack build verification"
pnpm --filter ./apps/backend run build
pnpm --filter ./apps/orchestrator run build

echo "[STEP] 6/6 Optional live factory e2e"
./scripts/wsl/factory-live-e2e.sh

echo "[DONE] acceptance check passed"
