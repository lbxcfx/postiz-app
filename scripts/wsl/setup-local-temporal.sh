#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
INSTALL_DIR="${HOME}/.local/bin"

TEMPORAL_ADDRESS_VALUE="${TEMPORAL_ADDRESS_VALUE:-127.0.0.1:7233}"
TEMPORAL_UI_PORT_VALUE="${TEMPORAL_UI_PORT_VALUE:-8080}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] Missing command: $1"
    exit 1
  }
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return
  fi
  if [[ -f "${ENV_EXAMPLE_FILE}" ]]; then
    cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    echo "[INFO] Created .env from .env.example"
    return
  fi
  echo "[ERROR] .env and .env.example are both missing"
  exit 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "${value}" | sed 's/[&|]/\\&/g')"

  if grep -qE "^${key}=" "${ENV_FILE}"; then
    sed -i -E "s|^${key}=.*|${key}=\"${escaped}\"|" "${ENV_FILE}"
  else
    echo "${key}=\"${value}\"" >>"${ENV_FILE}"
  fi
}

resolve_arch() {
  local uname_arch
  uname_arch="$(uname -m)"
  case "${uname_arch}" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "[ERROR] Unsupported architecture: ${uname_arch}"
      exit 1
      ;;
  esac
}

install_temporal_cli() {
  local arch release_json tag version asset_name download_url tmp_dir

  require_cmd curl
  require_cmd tar

  arch="$(resolve_arch)"
  echo "[STEP] Resolving latest Temporal CLI release"
  release_json="$(curl -fsSL https://api.github.com/repos/temporalio/cli/releases/latest)"
  tag="$(printf '%s\n' "${release_json}" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ -z "${tag}" ]]; then
    echo "[ERROR] Failed to resolve latest Temporal CLI version"
    exit 1
  fi

  version="${tag#v}"
  asset_name="temporal_cli_${version}_linux_${arch}.tar.gz"
  download_url="$(
    printf '%s\n' "${release_json}" |
      sed -n "s#^[[:space:]]*\"browser_download_url\":[[:space:]]*\"\\(https://[^\"]*${asset_name}\\)\".*#\\1#p" |
      head -n 1
  )"
  if [[ -z "${download_url}" ]]; then
    echo "[ERROR] Failed to resolve download URL for ${asset_name}"
    exit 1
  fi

  echo "[STEP] Installing Temporal CLI ${tag}"
  tmp_dir="$(mktemp -d)"

  curl -fsSL "${download_url}" -o "${tmp_dir}/temporal.tar.gz"
  tar -xzf "${tmp_dir}/temporal.tar.gz" -C "${tmp_dir}"
  mkdir -p "${INSTALL_DIR}"
  install -m 0755 "${tmp_dir}/temporal" "${INSTALL_DIR}/temporal"
  rm -rf "${tmp_dir}"

  echo "[OK] Installed temporal to ${INSTALL_DIR}/temporal"
  "${INSTALL_DIR}/temporal" --version || true
}

main() {
  install_temporal_cli
  ensure_env_file

  echo "[STEP] Updating ${ENV_FILE}"
  cp "${ENV_FILE}" "${ENV_FILE}.bak.temporal.$(date +%Y%m%d%H%M%S)"
  set_env_value "TEMPORAL_ADDRESS" "${TEMPORAL_ADDRESS_VALUE}"
  set_env_value "TEMPORAL_UI_PORT" "${TEMPORAL_UI_PORT_VALUE}"

  echo "[DONE] Local Temporal setup completed"
  echo "[INFO] Next run:"
  echo "       USE_LOCAL_TEMPORAL=1 USE_LOCAL_POSTGRES_REDIS=1 ./scripts/wsl/start-dev.sh"
}

main "$@"
