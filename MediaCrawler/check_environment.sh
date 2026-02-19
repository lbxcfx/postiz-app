#!/bin/bash

echo "====================================="
echo "  MediaCrawler 环境检查工具"
echo "====================================="
echo ""

ERROR_COUNT=0

echo "[检查 1/5] Python 版本..."
if command -v python3 &> /dev/null; then
    python3 --version
    echo "✓ Python 已安装"
else
    echo "✗ Python 未安装！"
    echo "  请从 https://www.python.org/ 下载安装"
    ((ERROR_COUNT++))
fi
echo ""

echo "[检查 2/5] uv 包管理工具..."
if command -v uv &> /dev/null; then
    uv --version
    echo "✓ uv 已安装"
else
    echo "✗ uv 未安装！"
    echo "  请从 https://docs.astral.sh/uv/getting-started/installation/ 安装"
    ((ERROR_COUNT++))
fi
echo ""

echo "[检查 3/5] Node.js 版本..."
if command -v node &> /dev/null; then
    node --version
    echo "✓ Node.js 已安装"
else
    echo "✗ Node.js 未安装！"
    echo "  请从 https://nodejs.org/ 下载安装"
    ((ERROR_COUNT++))
fi
echo ""

echo "[检查 4/5] npm 包管理器..."
if command -v npm &> /dev/null; then
    npm --version
    echo "✓ npm 已安装"
else
    echo "✗ npm 未安装！"
    echo "  npm 通常随 Node.js 一起安装"
    ((ERROR_COUNT++))
fi
echo ""

echo "[检查 5/5] 项目文件..."
if [ -f "main.py" ]; then
    echo "✓ main.py 存在"
else
    echo "✗ main.py 不存在！"
    echo "  请确保在项目根目录运行此脚本"
    ((ERROR_COUNT++))
fi

if [ -d "webui" ]; then
    echo "✓ webui 目录存在"
else
    echo "✗ webui 目录不存在！"
    ((ERROR_COUNT++))
fi
echo ""

echo "====================================="
if [ $ERROR_COUNT -eq 0 ]; then
    echo "  ✓ 所有检查通过！"
    echo "  您可以运行 ./start_webui.sh 启动WebUI"
else
    echo "  ✗ 发现 $ERROR_COUNT 个问题"
    echo "  请先解决上述问题后再启动WebUI"
fi
echo "====================================="
echo ""
