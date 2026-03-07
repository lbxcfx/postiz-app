#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="postiz-dev-social-auto-upload.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
RUN_USER="${POSTIZ_RUN_USER:-lbx}"

find_workdir() {
  local candidate
  for candidate in "${POSTIZ_WORKDIR:-}" "/mnt/f/postiz-app" "/home/lbx/postiz-app"; do
    if [[ -n "${candidate}" && -f "${candidate}/social-auto-upload-main/social-auto-upload-main/sau_backend.py" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

WORKDIR="$(find_workdir || true)"
if [[ -z "${WORKDIR}" ]]; then
  echo "[ensure-social-auto-upload-systemd] Unable to locate Postiz workdir with social-auto-upload." >&2
  exit 1
fi

if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  echo "[ensure-social-auto-upload-systemd] User '${RUN_USER}' not found." >&2
  exit 1
fi

cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=Postiz Social Auto Upload Dev API
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}/social-auto-upload-main/social-auto-upload-main
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/env bash -lc 'export PATH="\$HOME/.local/bin:\$PATH"; if [[ ! -x .venv/bin/python ]]; then python3 -m venv .venv; fi; if ! .venv/bin/python -c "import flask_cors, playwright, xhs" >/dev/null 2>&1; then if command -v uv >/dev/null 2>&1; then uv pip install --python .venv/bin/python flask flask-cors playwright xhs loguru requests python-dateutil; else .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 || true; .venv/bin/python -m pip install flask flask-cors playwright xhs loguru requests python-dateutil; fi; fi; exec .venv/bin/python sau_backend.py'
Restart=always
RestartSec=2
TimeoutStopSec=20
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
echo "[ensure-social-auto-upload-systemd] Installed ${SERVICE_NAME} (workdir=${WORKDIR})."
