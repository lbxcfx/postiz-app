#!/usr/bin/env bash
set -euo pipefail

SINCE="${1:-2026-02-24 14:50:00}"

echo "=== backend: fetch failed ==="
journalctl -u postiz-dev-backend.service --since "${SINCE}" --no-pager | grep -i "fetch failed" || true

echo
echo "=== backend: creation/error/workflow ==="
journalctl -u postiz-dev-backend.service --since "${SINCE}" --no-pager | grep -Ei "creation/start|factory/creation|exception|error|badrequest|temporal|workflow" || true

echo
echo "=== orchestrator: failed/error/fetch/workflow ==="
journalctl -u postiz-dev-orchestrator.service --since "${SINCE}" --no-pager | grep -Ei "failed|error|fetch|workflow" || true
