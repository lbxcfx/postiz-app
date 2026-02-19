#!/usr/bin/env bash
set -euo pipefail

# Force kill old processes to free ports
echo "[INFO] Cleaning up ports..."
fuser -k 3000/tcp || true
fuser -k 4200/tcp || true
fuser -k 8081/tcp || true
fuser -k 5409/tcp || true

# Setup Environment
export PATH="$HOME/.local/bin:$PATH"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export FORCE_WSL_DEV=1
export NODE_OPTIONS=--max-old-space-size=4096

# Check Python
if ! command -v python3 >/dev/null; then
    echo "[ERROR] python3 not found."
    exit 1
fi

# Start Services
echo "[INFO] Starting Services in ${ROOT_DIR}..."

# 1. MediaCrawler
echo "[START] MediaCrawler..."
cd "${ROOT_DIR}/MediaCrawler"
nohup python3 main.py --host 0.0.0.0 --port 8081 --reload > "${ROOT_DIR}/.runtime/logs/mediacrawler.log" 2>&1 &

# 2. Social Auto Upload
echo "[START] Social Auto Upload..."
cd "${ROOT_DIR}/social-auto-upload-main/social-auto-upload-main"
# Ensure uv is available or fallback to python
if command -v uv >/dev/null; then
    nohup uv run python3 sau_backend.py > "${ROOT_DIR}/.runtime/logs/social_auto_upload.log" 2>&1 &
else
    nohup python3 sau_backend.py > "${ROOT_DIR}/.runtime/logs/social_auto_upload.log" 2>&1 &
fi

# 3. Backend & Frontend (Node)
echo "[START] Node Services..."
cd "${ROOT_DIR}"
nohup pnpm --filter ./apps/backend run dev > "${ROOT_DIR}/.runtime/logs/backend.log" 2>&1 &
nohup pnpm --filter ./apps/frontend run dev > "${ROOT_DIR}/.runtime/logs/frontend.log" 2>&1 &

echo "[DONE] All services started. Please wait 30s for initialization."
