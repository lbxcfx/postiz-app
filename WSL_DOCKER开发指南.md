# WSL + Docker 联合开发指南

本文档用于当前 `postiz-app` 的本地开发模式：`WSL Ubuntu + Docker Desktop`。

## 1. 架构约定

- 应用进程在 WSL Ubuntu 内运行：
  - Frontend: `4200`
  - Backend: `3000`
  - Orchestrator: `main` task queue
  - MediaCrawler: `8081`
  - social-auto-upload: `5409`
- 基础依赖由 Docker 提供：
  - Postgres: `5432`
  - Redis: `6379`
  - Temporal: `7233`
  - Temporal UI: `8080`
  - pgAdmin: `8082`

## 2. 一次性准备

在 WSL 内执行：

```bash
cd /mnt/f/postiz-app
cp .env.example .env
pnpm install
pnpm run prisma-generate
```

## 3. 启动全链路开发

```bash
cd /mnt/f/postiz-app
chmod +x scripts/wsl/*.sh
./scripts/wsl/start-dev.sh
```

日志目录：

- `.runtime/logs/backend.log`
- `.runtime/logs/frontend.log`
- `.runtime/logs/orchestrator.log`
- `.runtime/logs/mediacrawler.log`
- `.runtime/logs/social_auto_upload.log`

## 4. 健康检查

```bash
cd /mnt/f/postiz-app
./scripts/wsl/health-check.sh
```

## 5. 启动前检查（建议每次开发前执行）

```bash
cd /mnt/f/postiz-app
chmod +x scripts/wsl/*.sh
./scripts/wsl/preflight-check.sh
```

该脚本会校验：

- 本机命令链（`node/pnpm/docker/curl`）
- `.env` 文件存在性与关键变量
- `docker compose` 服务状态

## 6. 验收检查（上线前）

```bash
cd /mnt/f/postiz-app
chmod +x scripts/wsl/*.sh
./scripts/wsl/acceptance-check.sh
```

该脚本会串行执行：

1. preflight
2. runtime health-check
3. 三端构建（backend/orchestrator/frontend）
4. 后端重试历史核心单测

## 7. 停止全链路

```bash
cd /mnt/f/postiz-app
./scripts/wsl/stop-dev.sh
```

## 8. 关键环境变量（V1）

- `MEDIACRAWLER_API_URL=http://localhost:8081`
- `CHINA_SOCIAL_SERVICE_URL=http://localhost:5409`
- `MATERIALS_MAX_RUNTIME_SECONDS=180`
- `MATERIALS_POLL_INTERVAL_MS=3000`
- `QWEN_API_KEY=...`（兼容 `DASHSCOPE_API_KEY`）
- `QWEN_API_BASE_URL=https://dashscope.aliyuncs.com/api/v1`
- `TEMPORAL_ADDRESS=localhost:7233`

## 9. 常见问题

- Docker 启动失败：
  - 先在 Windows 启动 Docker Desktop，再在 WSL 执行脚本。
- 端口冲突：
  - pgAdmin 已固定为 `8082`，避免与 MediaCrawler `8081` 冲突。
- 前端无法连接后端：
  - 检查 `.env` 中 `NEXT_PUBLIC_BACKEND_URL=http://localhost:3000`。
