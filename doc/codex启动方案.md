# Codex 启动方案（WSL / Windows `cmd` 实战版）

本文档基于 2026-02-16 的实际排障结果，作为 `启动方案.md` 的 Codex 终端补充版，后续优先按本文执行。

## 1. 启动目标

需要拉起并验证以下服务：

- Backend: `http://localhost:3000/docs`（期望 `200`）
- Frontend: `http://localhost:4200`（期望 `307` 跳转到 `/auth`）
- MediaCrawler: `http://localhost:8081/docs`（期望 `200`）

## 2. 标准启动步骤（推荐）

### 步骤 1：若 WSL 异常，先重置

```cmd
wsl --shutdown
wsl -d Ubuntu -- echo WSL_OK
```

如果第二条命令输出 `WSL_OK`，说明 WSL 已恢复。

### 步骤 2：启动主服务

```cmd
wsl -d Ubuntu --cd /home/lbx/postiz-app -- bash scripts/wsl/start-dev.sh
```

### 步骤 3：健康检查

```cmd
wsl -d Ubuntu --cd /home/lbx/postiz-app -- bash scripts/wsl/health-check.sh
```

说明：`social-auto-upload` 默认不作为阻断项；如需强制校验，增加环境变量 `CHECK_SOCIAL_AUTO_UPLOAD=1`。

## 3. 本次遇到的问题与结论（2026-02-16）

### 问题 A：`localhost:4200` 一直加载

- 现象：页面长时间转圈，偶发无法打开。
- 结论：不是 OOM。前端日志显示首编译很慢（`/launches` 首次编译约 178s），属于 Next.js dev 首次编译开销。
- 证据：
  - `frontend.log` 有 `Ready` 和 `Compiled`，无 `heap out of memory`。
  - `journalctl -k -g oom` 无 OOM 记录。
  - `free -h` 显示仍有可用内存。

### 问题 B：WSL 间歇报错（`Wsl/Service/0x8007274c` 或 `E_UNEXPECTED`）

- 现象：`wsl -d Ubuntu -- ...` 偶发直接失败。
- 处理：执行 `wsl --shutdown` 后重试，通常可恢复。

### 问题 C：Backend 起不来，报 `connect ECONNREFUSED 127.0.0.1:7233`

- 根因：Temporal 服务不可达（`7233` 未监听）。
- 处理：
  1. 用 Windows Docker CLI 单独拉起 `temporal`（避免 WSL 内 docker socket 异常）：
     ```cmd
     C:\Progra~1\Docker\Docker\resources\bin\docker.exe compose -f F:\postiz-app\docker-compose.dev.yaml up -d temporal
     ```
  2. 再执行 `start-dev.sh`。

### 问题 D：`start-dev.sh` 里 `temporal Recreate` 失败

- 错误：`/run/guest-services/distro-services/ubuntu.sock: no such file or directory`
- 结论：WSL 内部 Docker 调用偶发失效。
- 处理：用 Windows `docker.exe` 执行 compose（见问题 C）。

### 问题 E：MediaCrawler 未启动（8081 为 `000`）

- 现象：`.runtime/logs/mediacrawler.log` 为空，PID 文件存在但进程已退出。
- 处理：手动单独拉起：
  ```cmd
  wsl -d Ubuntu --cd /home/lbx/postiz-app/MediaCrawler -- setsid -f python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload
  ```

### 问题 F：`social_auto_upload` 启动失败

- 错误：`ModuleNotFoundError: No module named 'flask_cors'`
- 结论：Python 依赖不完整，不影响 `3000/4200/8081` 主链路。

### 问题 G：`/auth/login` 出现 `Unhandled Runtime Error: TypeError: Failed to fetch`

- 现象：页面堆栈定位到 `libraries/helpers/src/utils/custom.fetch.func.ts` 的 `fetch(...)`。
- 根因：Backend `3000` 不可达时，登录页未捕获网络异常，导致前端直接抛出运行时错误。
- 处理（已落地）：
  - 在 `apps/frontend/src/components/auth/login.tsx` 的提交逻辑中增加 `try/catch/finally`。
  - 当后端不可达时显示表单错误：`Unable to reach server. Please check backend service.`，不再红屏。

### 问题 H：WSL 到 Postgres/Redis 连接在协议阶段被重置（非 OOM）

- 现象：
  - `nc -zv` 显示端口可连（5432/6379），但 `.env` 使用 `host.docker.internal` 时，Prisma / ioredis 连接失败。
  - Backend 日志出现 `PrismaClientInitializationError: Can't reach database server ...`、`write EPIPE`。
- 结论：
  - 不是内存不足：`docker stats` 无容器 OOM，`postiz-postgres/postiz-redis` 内存占用很低。
  - 在本环境下，WSL Node 对 `127.0.0.1` 正常，对 `host.docker.internal` 不稳定；应固定使用 `127.0.0.1`。
- 快速验证命令：
  ```cmd
  wsl --cd /home/lbx/postiz-app -- node scripts/wsl/check-db-tables.js
  wsl --cd /home/lbx/postiz-app -- node test-redis.js
  ```
  若成功则输出表/读写测试结果；若失败优先检查 `.env` 中 `DATABASE_URL/REDIS_URL` host 是否为 `127.0.0.1`。

### 问题 I：`5432` 端口握手被异常断开（Postgres `Connection terminated unexpectedly`）

- 现象：
  - `nc -zv` 到 `127.0.0.1:5432` 显示可连，但 Prisma / `pg` 客户端握手直接断开。
  - Redis 同机可用，说明并非整体网络故障。
- 根因：开发机本地 `5432` 存在额外监听/冲突风险，Docker 映射到 `5432` 时不稳定。
- 长期修复（已落地）：
  - `docker-compose.dev.yaml` 将 Postiz Postgres 端口改为 `55432:5432`
  - `.env` 的 `DATABASE_URL` 同步改为 `127.0.0.1:55432`
  - `health-check.sh` 按 `.env` 自动解析 Postgres host/port，不再写死 `5432`

## 6. 长期改造（已落地）

已在启动脚本中加入自动防错，后续直接使用：

```cmd
wsl -d Ubuntu --cd /home/lbx/postiz-app -- bash scripts/wsl/start-dev.sh
```

改造内容：

- `scripts/wsl/start-dev.sh`
  - 启动前自动检查 `.env`：
    - 若 `DATABASE_URL` 或 `REDIS_URL` 使用 `host.docker.internal`，自动替换为 `127.0.0.1`
    - 自动备份到 `.env.bak.wsl`
  - Docker Compose 启动失败时，自动回退到 Windows `docker.exe compose`
  - Docker infra 启动后，强制执行连通性校验：
    - `node scripts/wsl/test-prisma-connect.js`
    - `node test-redis.js`
  - 校验失败会直接终止启动并给出修复提示，避免进入半启动状态
  - 进程启动改为 `setsid` + `nohup`，避免 `pnpm dev` 被 `SIGHUP` 提前挂断

- `scripts/wsl/preflight-check.sh`
  - 新增 `.env` host 兼容性检查：
    - `DATABASE_URL/REDIS_URL` 使用 `host.docker.internal` 会直接 fail
  - WSL `docker compose ps` 失败时自动回退到 Windows `docker.exe compose ps`

可选项：

- 跳过自动修复：
  ```cmd
  wsl -d Ubuntu --cd /home/lbx/postiz-app -- env SKIP_ENV_AUTO_FIX=1 bash scripts/wsl/start-dev.sh
  ```

## 4. 一键恢复流程（遇到异常时直接执行）

```cmd
wsl --shutdown
wsl -d Ubuntu -- echo WSL_OK
C:\Progra~1\Docker\Docker\resources\bin\docker.exe compose -f F:\postiz-app\docker-compose.dev.yaml up -d temporal
wsl -d Ubuntu --cd /home/lbx/postiz-app -- env FORCE_WSL_DEV=1 NODE_OPTIONS=--max-old-space-size=3072 bash scripts/wsl/start-dev.sh
wsl -d Ubuntu --cd /home/lbx/postiz-app/MediaCrawler -- setsid -f python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8081 --reload
wsl -d Ubuntu --cd /home/lbx/postiz-app -- bash scripts/wsl/health-check.sh
```

## 5. 验收标准

以下检查全部通过即可开始使用：

```cmd
wsl -d Ubuntu -- bash -lc "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/docs"
wsl -d Ubuntu -- bash -lc "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4200"
wsl -d Ubuntu -- bash -lc "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/docs"
```

期望：

- Backend: `200`
- Frontend: `307`
- MediaCrawler: `200`

## 7. 2026-02-17 追加问题与修复

### 问题 J：素材卡片图片/视频全部“加载失败”

- 根因：后端 `transformLocalPaths` 把本地素材地址拼成了 `.../api/materials/file/...`，但实际路由是 `.../materials/file/...`。
- 修复（已落地）：
  - 文件：`apps/backend/src/api/routes/materials.controller.ts`
  - 调整：`/api/materials/file/` -> `/materials/file/`

### 问题 K：输入“西双版纳”后结果与关键词不一致

- 根因 1：MediaCrawler 输出文件名未携带 `client_job_id`，后端按时间兜底时可能选到旧任务文件。
- 修复（已落地）：
  - 文件：`MediaCrawler/tools/async_file_writer.py`
  - 调整：输出文件名增加 `job_{client_job_id}__` 前缀（并保留关键词后缀）。

- 根因 2：XHS 参数未显式传递时会回落到全局高阈值默认（最低点赞/最小保存数），导致关键词结果可能被过度过滤。
- 修复（已落地）：
  - 文件：`MediaCrawler/api/services/crawler_manager.py`
  - 调整：始终显式传入 `--xhs_min_liked_count` 与 `--xhs_min_save_count`（包括 `0`）。

### 问题 L：启动脚本误改 `.env` host 导致连接不稳定

- 现象：原脚本会把 `host.docker.internal` 强制替换为 `127.0.0.1`，在部分机器上会把可用配置改坏。
- 修复（已落地）：
  - 文件：`scripts/wsl/start-dev.sh`
  - 调整：
    - 先起 Docker infra，再按端口可达性自动探测并修正 `DATABASE_URL/REDIS_URL` host；
    - 增加 Docker 路径兼容（`/mnt/c/Program Files/...` 与 `/mnt/c/Progra~1/...`）。

### 说明：当前机器仍可能出现 Docker 端口转发异常

- 表现：`docker ps` 显示 `55432/6379` 已映射，但主机侧握手被 `ECONNRESET`。
- 结论：属于本机 Docker/网络转发层问题，不是业务服务 OOM 或代码逻辑问题。

## 8. 2026-02-18 启动与素材链路更新（最新）

### 8.1 推荐启动方式（双击）

- 直接双击：`run-keepalive.cmd`
- 作用：
  - 自动确保并启动 `postiz-dev-temporal.service`
  - 自动确保并启动 `postiz-dev-backend.service`
  - 自动确保并启动 `postiz-dev-orchestrator.service`
  - 自动确保并启动 `postiz-dev-frontend.service`
  - 自动确保并启动 `postiz-dev-mediacrawler.service`
  - 保持窗口常驻（`tail -f /dev/null`），防止 WSL 会话退出导致服务掉线

### 8.2 命令行启动方式

```cmd
run-keepalive.cmd
```

仅启动一次（不常驻）：

```cmd
run-keepalive.cmd --once
```

### 8.3 启动后快速验证

```cmd
wsl -d Ubuntu -u root -- systemctl is-active postiz-dev-frontend.service
wsl -d Ubuntu -u root -- systemctl is-active postiz-dev-backend.service
wsl -d Ubuntu -u root -- systemctl is-active postiz-dev-mediacrawler.service
wsl -d Ubuntu -- curl -s -o /dev/null -w "%{http_code}" http://localhost:4200
wsl -d Ubuntu -- curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/docs
wsl -d Ubuntu -- curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/docs
```

期望：
- frontend: `307`
- backend: `200`
- mediacrawler: `200`

### 8.4 本次素材页“已登录但无搜索结果”根因与修复

- 现象 1：未扫码/未输验证码就显示“已登录”
  - 结论：属于 Cookie 免登录命中，非异常。
  - 校验接口：
    - `GET http://localhost:8081/api/crawler/login-status/xhs`
    - 返回 `has_valid_login=true` 且有 `a1/web_session` 时，前端应显示已登录。

- 现象 2：输入关键词（如“西双版纳”）后无结果或很慢
  - 根因 A：历史任务启动参数为 `--get_comment true`，先抓评论，任务长时间不结束。
  - 根因 B：MediaCrawler 的增量去重会跳过历史已抓笔记，同关键词重复搜索可能只剩少量数据。

- 已落地修复：
  - `libraries/nestjs-libraries/src/materials/materials.queue.service.ts`
    - 默认不抓评论：仅当 `MATERIALS_ENABLE_COMMENTS=1` 才开启评论抓取。
  - `libraries/nestjs-libraries/src/materials/materials.crawler.service.ts`
    - 补充并透传 `enable_comments` / `enable_sub_comments`。
  - `MediaCrawler/store/xhs/_store_impl.py`
    - 默认关闭跨任务增量去重（`XHS_INCREMENTAL_MODE` 默认 `false`）。
    - 如需恢复增量模式可显式设置：`XHS_INCREMENTAL_MODE=1`。

### 8.5 素材搜索排查命令（继续开发必备）

查看当前爬虫任务状态：

```cmd
wsl -d Ubuntu -- curl -s http://localhost:8081/api/crawler/status
```

查看最近日志（确认是否仍在抓评论）：

```cmd
wsl -d Ubuntu -- curl -s http://localhost:8081/api/crawler/logs?limit=200
```

重点检查启动行是否包含：
- `--get_comment false`
- `--get_sub_comment false`

若任务卡住可停止后重试：

```cmd
wsl -d Ubuntu -- curl -s -X POST http://localhost:8081/api/crawler/stop
```

### 8.6 重启命令（代码更新后）

```cmd
wsl -d Ubuntu -u root -- systemctl restart postiz-dev-mediacrawler.service
wsl -d Ubuntu -u root -- systemctl restart postiz-dev-backend.service
wsl -d Ubuntu -u root -- systemctl restart postiz-dev-frontend.service
```

## 9. 2026-02-20 启动方式更新（当前执行标准）

### 9.1 脚本名确认

- 正确脚本名：`run-keepalive.cmd`
- 错误写法：`run_keepalive.cmd`（不存在）

### 9.2 Codex 当前使用的启动命令（推荐）

```cmd
run-keepalive.cmd --once
```

说明：
- 会自动同步代码到 WSL 运行目录；
- 自动安装依赖、构建 backend/orchestrator；
- 自动重启 5 个 systemd 服务；
- 适合“更新代码后立即生效”场景。

### 9.3 常驻模式启动（双击或命令行）

```cmd
run-keepalive.cmd
```

说明：会保持窗口常驻，避免 WSL 会话退出导致服务掉线。

### 9.4 完全手动启动命令（不依赖 cmd 脚本）

```cmd
wsl -d Ubuntu -u root -- bash -lc "set -e; POSTIZ_WORKDIR=/mnt/f/postiz-app bash /mnt/f/postiz-app/scripts/wsl/ensure-postiz-systemd.sh; systemctl restart postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service; systemctl is-active postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service"
```

### 9.5 手动检查命令

```cmd
wsl -d Ubuntu -u root -- systemctl is-active postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service
wsl -d Ubuntu -u root -- journalctl -u postiz-dev-frontend.service -n 120 --no-pager
wsl -d Ubuntu -u root -- journalctl -u postiz-dev-backend.service -n 120 --no-pager
wsl -d Ubuntu -u root -- journalctl -u postiz-dev-mediacrawler.service -n 120 --no-pager
```
