#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[STEP] Factory chain build checks"
pnpm --filter ./apps/backend run build
pnpm --filter ./apps/orchestrator run build

echo "[STEP] Factory chain unit/integration checks"
pnpm exec jest -c apps/backend/jest.config.ts \
  --runTestsByPath apps/backend/src/services/factory/factory.service.spec.ts \
  --runInBand --forceExit

pnpm exec jest -c apps/orchestrator/jest.config.ts \
  --runTestsByPath apps/orchestrator/src/activities/analysis.service.spec.ts \
  --runTestsByPath apps/orchestrator/src/activities/content-factory.activity.spec.ts \
  --runInBand --forceExit

echo "[DONE] factory chain checks passed"
