#!/usr/bin/env bash
set -euo pipefail

pids="$(pgrep -f 'apps/backend' || true)"
if [[ -n "${pids}" ]]; then
  # shellcheck disable=SC2086
  kill -9 ${pids} >/dev/null 2>&1 || true
fi

echo "[DONE] backend processes killed"
