#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="postiz-dev-mediacrawler.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
RUN_USER="${POSTIZ_RUN_USER:-lbx}"

find_workdir() {
  local candidate
  for candidate in "${POSTIZ_WORKDIR:-}" "/home/lbx/postiz-app" "/mnt/f/postiz-app"; do
    if [[ -n "${candidate}" && -x "${candidate}/MediaCrawler/.venv/bin/python" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

WORKDIR="$(find_workdir || true)"
if [[ -z "${WORKDIR}" ]]; then
  echo "[ensure-mediacrawler-systemd] Unable to locate Postiz workdir with MediaCrawler venv." >&2
  exit 1
fi

if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  echo "[ensure-mediacrawler-systemd] User '${RUN_USER}' not found." >&2
  exit 1
fi

cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=Postiz MediaCrawler Dev API
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}/MediaCrawler
Environment=PYTHONUNBUFFERED=1
ExecStart=${WORKDIR}/MediaCrawler/.venv/bin/python -m uvicorn api.main:app --host 127.0.0.1 --port 8081 --reload
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
echo "[ensure-mediacrawler-systemd] Installed ${SERVICE_NAME} (workdir=${WORKDIR})."
