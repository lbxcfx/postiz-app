#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${POSTIZ_RUN_USER:-lbx}"
SERVICE_DIR="/etc/systemd/system"

find_source_workdir() {
  local candidate
  for candidate in "${POSTIZ_WORKDIR:-}" "/mnt/f/postiz-app" "/home/lbx/postiz-app"; do
    if [[ -n "${candidate}" && -f "${candidate}/package.json" && -d "${candidate}/apps/frontend" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  echo "[ensure-postiz-systemd] User '${RUN_USER}' not found." >&2
  exit 1
fi

SOURCE_WORKDIR="$(find_source_workdir || true)"
if [[ -z "${SOURCE_WORKDIR}" ]]; then
  echo "[ensure-postiz-systemd] Unable to locate Postiz workdir." >&2
  exit 1
fi

RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
if [[ -z "${RUN_HOME}" ]]; then
  echo "[ensure-postiz-systemd] Unable to resolve home for user '${RUN_USER}'." >&2
  exit 1
fi

RUNTIME_WORKDIR="${POSTIZ_RUNTIME_DIR:-${RUN_HOME}/postiz-app}"
mkdir -p "${RUNTIME_WORKDIR}"

if [[ "${SOURCE_WORKDIR}" != "${RUNTIME_WORKDIR}" ]]; then
  echo "[ensure-postiz-systemd] Sync source to runtime (${SOURCE_WORKDIR} -> ${RUNTIME_WORKDIR})"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.runtime' \
    --exclude '.next' \
    --exclude '.turbo' \
    --exclude 'MediaCrawler/browser_data' \
    "${SOURCE_WORKDIR}/" "${RUNTIME_WORKDIR}/"
fi

WORKDIR="${RUNTIME_WORKDIR}"
chown -R "${RUN_USER}:${RUN_USER}" "${WORKDIR}" >/dev/null 2>&1 || true

mkdir -p "${WORKDIR}/.runtime/temporal"
chown -R "${RUN_USER}:${RUN_USER}" "${WORKDIR}/.runtime" >/dev/null 2>&1 || true

PNPM_BIN="${POSTIZ_PNPM_BIN:-}"
if [[ -z "${PNPM_BIN}" ]]; then
  PNPM_BIN="$(ls -1 "${RUN_HOME}"/.nvm/versions/node/*/bin/pnpm 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [[ -z "${PNPM_BIN}" ]]; then
  PNPM_BIN="$(su - "${RUN_USER}" -c 'command -v pnpm' 2>/dev/null || true)"
fi
if [[ -z "${PNPM_BIN}" || ! -x "${PNPM_BIN}" ]]; then
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
fi
if [[ -z "${PNPM_BIN}" || ! -x "${PNPM_BIN}" ]]; then
  echo "[ensure-postiz-systemd] Unable to locate pnpm binary." >&2
  exit 1
fi

NODE_BIN_DIR="$(dirname "${PNPM_BIN}")"
SYSTEM_PATH="${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TEMPORAL_BIN="${POSTIZ_TEMPORAL_BIN:-}"
if [[ -z "${TEMPORAL_BIN}" && -x "${RUN_HOME}/.local/bin/temporal" ]]; then
  TEMPORAL_BIN="${RUN_HOME}/.local/bin/temporal"
fi
if [[ -z "${TEMPORAL_BIN}" ]]; then
  TEMPORAL_BIN="$(su - "${RUN_USER}" -c 'command -v temporal' 2>/dev/null || true)"
fi
if [[ -z "${TEMPORAL_BIN}" || ! -x "${TEMPORAL_BIN}" ]]; then
  TEMPORAL_BIN="$(command -v temporal 2>/dev/null || true)"
fi
if [[ -z "${TEMPORAL_BIN}" || ! -x "${TEMPORAL_BIN}" ]]; then
  echo "[ensure-postiz-systemd] Unable to locate temporal binary." >&2
  exit 1
fi

if [[ "${POSTIZ_SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[ensure-postiz-systemd] Installing dependencies in runtime..."
  su - "${RUN_USER}" -c "cd '${WORKDIR}' && env PATH='${SYSTEM_PATH}' '${PNPM_BIN}' install"
fi

if [[ "${POSTIZ_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[ensure-postiz-systemd] Building backend and orchestrator dist..."
  su - "${RUN_USER}" -c "cd '${WORKDIR}' && env PATH='${SYSTEM_PATH}' '${PNPM_BIN}' --filter ./apps/backend run build"
  su - "${RUN_USER}" -c "cd '${WORKDIR}' && env PATH='${SYSTEM_PATH}' '${PNPM_BIN}' --filter ./apps/orchestrator run build"
fi

cat >"${SERVICE_DIR}/postiz-dev-temporal.service" <<EOF
[Unit]
Description=Postiz Temporal Dev Server (System)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}
ExecStart=${TEMPORAL_BIN} server start-dev --ip 127.0.0.1 --port 7233 --ui-ip 127.0.0.1 --ui-port 8080 --db-filename ${WORKDIR}/.runtime/temporal/temporal-dev.db
Restart=always
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

cat >"${SERVICE_DIR}/postiz-dev-backend.service" <<EOF
[Unit]
Description=Postiz Backend Dev (System)
After=network.target postiz-dev-temporal.service
Requires=postiz-dev-temporal.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}
Environment=PATH=${SYSTEM_PATH}
Environment=NODE_OPTIONS=--max-old-space-size=3072
ExecStart=${PNPM_BIN} --filter ./apps/backend run dev
Restart=always
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

cat >"${SERVICE_DIR}/postiz-dev-orchestrator.service" <<EOF
[Unit]
Description=Postiz Orchestrator Dev (System)
After=network.target postiz-dev-temporal.service
Requires=postiz-dev-temporal.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}
Environment=PATH=${SYSTEM_PATH}
Environment=NODE_OPTIONS=--max-old-space-size=3072
ExecStart=${PNPM_BIN} --filter ./apps/orchestrator run start
Restart=always
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

cat >"${SERVICE_DIR}/postiz-dev-frontend.service" <<EOF
[Unit]
Description=Postiz Frontend Dev (System)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKDIR}
Environment=PATH=${SYSTEM_PATH}
Environment=NODE_OPTIONS=--max-old-space-size=3072
ExecStart=${PNPM_BIN} --filter ./apps/frontend run dev
Restart=always
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

POSTIZ_WORKDIR="${WORKDIR}" POSTIZ_RUN_USER="${RUN_USER}" \
  bash "${WORKDIR}/scripts/wsl/ensure-mediacrawler-systemd.sh"
POSTIZ_WORKDIR="${WORKDIR}" POSTIZ_RUN_USER="${RUN_USER}" \
  bash "${WORKDIR}/scripts/wsl/ensure-social-auto-upload-systemd.sh"

systemctl daemon-reload
systemctl enable \
  postiz-dev-temporal.service \
  postiz-dev-backend.service \
  postiz-dev-orchestrator.service \
  postiz-dev-frontend.service \
  postiz-dev-mediacrawler.service \
  postiz-dev-social-auto-upload.service >/dev/null

echo "[ensure-postiz-systemd] Installed services with workdir=${WORKDIR}"
