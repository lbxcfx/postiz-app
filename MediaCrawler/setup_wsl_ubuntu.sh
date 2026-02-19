#!/bin/bash
set -e

# Support direct run from anywhere
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$PROJECT_ROOT"

echo "====================================="
echo "  MediaCrawler WSL Ubuntu 安装脚本"
echo "====================================="
echo ""

# 1. 检查并安装 uv
if ! command -v uv &> /dev/null; then
    echo "[1/4] 正在安装 uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # 为当前会话加载 uv
    if [ -f "$HOME/.local/bin/env" ]; then
        source "$HOME/.local/bin/env"
    else
        export PATH="$HOME/.local/bin:$PATH"
    fi
else
    echo "[1/4] uv 已安装"
fi

# 2. 同步 Python 环境
echo "[2/4] 正在配置 Python 虚拟环境并安装依赖..."
uv sync

# 3. 安装 Playwright 浏览器
echo "[3/4] 正在安装 Playwright 浏览器..."
uv run playwright install chromium

# 4. 前端构建 (如果需要)
if [ -d "webui" ] && [ -f "webui/package.json" ]; then
    echo "[4/4] 检查前端依赖..."
    cd webui
    if [ ! -d "node_modules" ]; then
        echo "正在安装前端依赖 (npm install)..."
        npm install
    fi
    echo "正在构建前端资源 (npm run build)..."
    npm run build
    cd ..
else
    echo "[4/4] 跳过前端构建 (源码目录不存在)"
fi

echo ""
echo "====================================="
echo "  安装完成！"
echo "====================================="
echo ""
echo "您可以运行以下命令启动服务："
echo "  uv run uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload"
echo ""
echo "注意：如果遇到浏览器库缺失错误，请运行："
echo "  sudo $(uv run playwright install-deps --dry-run)"
echo "====================================="
