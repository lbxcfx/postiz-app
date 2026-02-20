#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/mnt/f/postiz-app"
if [[ ! -f "${ROOT_DIR}/scripts/wsl/ensure-postiz-systemd.sh" && -f "/home/lbx/postiz-app/scripts/wsl/ensure-postiz-systemd.sh" ]]; then
  ROOT_DIR="/home/lbx/postiz-app"
fi

POSTIZ_WORKDIR="${ROOT_DIR}" bash "${ROOT_DIR}/scripts/wsl/ensure-postiz-systemd.sh"

systemctl restart \
  postiz-dev-temporal.service \
  postiz-dev-backend.service \
  postiz-dev-orchestrator.service \
  postiz-dev-frontend.service \
  postiz-dev-mediacrawler.service

pkill -f postiz-wsl-keepalive >/dev/null 2>&1 || true
nohup bash -lc "exec -a postiz-wsl-keepalive tail -f /dev/null" \
  >/tmp/postiz-wsl-keepalive.log 2>&1 < /dev/null &

systemctl is-active \
  postiz-dev-temporal.service \
  postiz-dev-backend.service \
  postiz-dev-orchestrator.service \
  postiz-dev-frontend.service \
  postiz-dev-mediacrawler.service

echo "[Postiz] keepalive process started in background."
