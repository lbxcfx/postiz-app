#!/bin/bash

# Support direct run from anywhere
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$PROJECT_ROOT"

echo "====================================="
echo "  MediaCrawler WebUI 启动脚本"
echo "====================================="
echo ""

# 检查是否已安装 uv
if ! command -v uv &> /dev/null; then
    # 尝试加载用户目录下的 uv
    if [ -f "$HOME/.local/bin/env" ]; then
        source "$HOME/.local/bin/env"
    elif [ -f "$HOME/.cargo/bin/uv" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
    fi
fi

if ! command -v uv &> /dev/null; then
    echo "[错误] 未找到 uv 命令！请先运行 ./setup_wsl_ubuntu.sh"
    exit 1
fi

echo "[1/2] 检查前端资源..."
if [ ! -d "api/webui" ] || [ ! -f "api/webui/index.html" ]; then
    echo "未找到构建好的前端资源，正在尝试构建..."
    if [ -d "webui" ]; then
        cd webui && npm run build && cd ..
    else
        echo "[错误] 既无构建资源也无 WebUI 源码，无法启动！"
        exit 1
    fi
fi

echo "[2/2] 启动后端服务..."
echo ""
echo "====================================="
echo "  WebUI 服务已启动！"
echo "  访问地址: http://localhost:8081"
echo "  按 Ctrl+C 可停止服务"
echo "====================================="
echo ""

# 使用 uv 运行
uv run uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload
