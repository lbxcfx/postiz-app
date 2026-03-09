# AI分析迁移开发清单（qwen-asr 时间戳版）

## 1. 目标与范围
本迁移面向素材库 -> AI分析页，核心目标是把 `autoclip-main` 中可复用的“内容理解能力”迁移到当前工程，且字幕识别统一使用 **qwen-asr API（含时间戳）**，不引入 whisper。

迁移关注三块：
- 视频处理（可选迁移）
- 字幕分析（qwen-asr）
- 内容理解（步骤方法、Prompt、大纲、时间线、评分、LLM抽象）

---

## 2. 当前已开发功能（已落代码）

### 2.0 本轮进展（2026-03-08）
- 已按 `run-keepalive.cmd --once` 完成环境搭建验证，后端/前端/编排等服务可拉起并进入 `active`。
- 已完成 AI 分析任务并发去重（inflight dedupe）：
  - 同素材连续点击会优先复用进行中的任务，不再无界重复入队。
  - 队列返回新增 `queueReason`、`dedupeKey` 用于定位复用原因。
  - 队列并发改为可配置：`MATERIALS_ANALYSIS_CONCURRENCY`（默认 2）。
  - 触发/状态接口补充 `queuePosition`，可观察排队位次。
- 已完成缓存可观测性增强：
  - `/materials/analysis` 与 `/materials/analysis/trigger` 返回 `cacheHit/cacheReason/cacheKey/cacheAgeSec`。
  - `/materials/analysis/job-status` 返回 `queuePosition/resultSource/cacheHit`。
  - 后端日志增加 cache hit/miss、入队、复用、fresh run 等关键事件。
  - 新增指标接口：`GET /materials/analysis/metrics`（按组织返回并发/复用/命中/取消统计与命中率）。
- 已完成任务取消能力（分析队列）：
  - 新增接口：`POST /materials/analysis/cancel`（参数：`jobId`）。
  - `queued` 任务可直接取消并返回 `cancelled`。
  - `running` 任务支持“取消请求 + AbortSignal强中断”，可在模型请求阶段快速中止。
  - 状态新增 `cancelled`，并保留取消可观测信息。
- 前端 AI 触发逻辑已调整为：默认 `force=false`，仅在检测到坏缓存时 `force=true`，降低重复任务与重复计算。
- 前端素材下载已增加跨素材并发控制：
  - `materials-media-cache.ts` 引入下载信号量，默认最多并发 2 个下载任务。
  - 可通过 `NEXT_PUBLIC_MATERIALS_MEDIA_DOWNLOAD_CONCURRENCY` 调整。
- 后端分析并发也支持配置：
  - 环境变量：`MATERIALS_ANALYSIS_CONCURRENCY`（默认 2）。
- 已完成 ASR/VL Provider 抽象与双供应商接入（阿里/豆包）：
  - 新增切换开关：`MATERIALS_ASR_PROVIDER=aliyun|doubao`、`MATERIALS_VL_PROVIDER=aliyun|doubao`。
  - ASR：
    - `aliyun` 继续走 qwen-asr/qwen-vl 音频转写链路。
    - `doubao` 新增 submit/query 异步识别链路（标准版 API），并统一归一化到 `segments[{startSec,endSec,text}]`。
      - 兼容请求头：`X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id` / `X-Api-Request-Id` / `X-Api-Sequence=-1`。
      - 支持可选 `DOUBAO_SECRET_TOKEN`，会额外附加 `Authorization: Bearer; <secret_token>`（便于不同租户鉴权差异）。
  - VL：
    - `aliyun` 保持现有 qwen-vl 能力。
    - `doubao` 新增 Ark `responses` 视觉理解链路（默认，支持 `input_image + input_text`），并保留 `chat/completions` 兜底。
      - `DOUBAO_VL_API_MODE=responses|chat`（默认 `responses`）
      - `DOUBAO_VL_RESPONSES_URL`（可选覆盖，默认 `${DOUBAO_ARK_BASE_URL}/responses`）
      - `DOUBAO_VL_CHAT_URL`（可选覆盖，默认 `${DOUBAO_ARK_BASE_URL}/chat/completions`）
      - `video_url` 直连仍受 `DOUBAO_VL_ALLOW_VIDEO_URL=true` 控制。
  - 当 qwen key 缺失但豆包配置齐全时，AI分析不再提前整体降级；语义层缺 qwen 时会走规则兜底。
- 已完成关键帧分析结果结构迁移（video-analyzer 风格）：
  - `aiDetailLayer.vision` 新增 `frameAnalyses[]`（`index/timestampSec/timestampLabel/summary/keywords`）。
  - 视觉模型 Prompt 增强为返回 `frameAnalyses`，并提供多层解析兜底（`frameAnalyses/frame_analyses/frames/keyframes`）。
  - AI分析页已新增“关键帧分析（Top6）”展示区。
  - 后端已实现“视频抽帧 + 逐帧视觉分析”能力：
    - 优先使用 `ffprobe/ffmpeg` 从视频 URL 抽关键帧为 base64 data URL。
    - 逐帧调用 VL 模型进行分析，再汇总为 `summary/keywords/scenes/keyframes/frameAnalyses`。
    - 抽帧失败会自动回退到原有 `video_url` 或封面图分析，不阻断主流程。
- AI分析页已完成时间轴联动：
  - 点击“关键帧分析 / 时间线片段 / 评分高能片段 / ASR时间戳分段”可直接跳播到对应秒位。
- AI分析页可视化交互已增强：
  - 已支持“当前播放时间高亮对应片段”（时间线/评分片段/关键帧/ASR分段）。
  - 已支持 ASR 分段关键词搜索与展开/收起（默认展示前10段，可展开全部）。
  - 已支持“关键帧缩略图网格”（点击缩略图跳播，随播放时间高亮）。
  - 已支持关键帧缩略图懒加载骨架占位（加载完成后平滑显示）。
  - 已支持 AI 分析步骤进度条（缓存 -> 排队 -> 分析 -> 完成）。
  - 已支持前端埋点：
    - 跳播点击（时间线/评分/ASR/关键帧文本/关键帧缩略图）
    - 缓存命中与缓存未命中（内存命中、analysis接口命中、trigger短路命中）
    - 分析步骤与耗时（缓存开始/完成、排队、运行、成功/失败、取消）
  - 已完成关键状态区文案统一（zh/en）：空态、顶部操作区、分析中状态文案、跳播提示文案。
  - 已补页面细节动效：卡片入场渐显、关键帧卡片悬停动效、减少动画偏好兼容。
- 已补回归测试（后端）：
  - `materials.controller.analysis.spec.ts` 覆盖缓存命中、新任务入队、inflight 复用与排队位次。
  - `materials.analysis.service.spec.ts` 覆盖视觉分析输入类型、豆包VL切换、豆包ASR submit/query、锁占用回退。
  - 新增联调用回归脚本：`scripts/materials-analysis-regression.js`（验证跨素材并发、排队位次、复用与状态字段）。

### 2.1 后端：AI分析主流程已接入“内容理解层”
文件：`libraries/nestjs-libraries/src/materials/materials.analysis.service.ts`

已完成：
- 新增 `contentUnderstandingLayer` 结构并写入分析结果。
- 内容理解拆分为 3 步：
  1) `runContentOutlineStep`（大纲）
  2) `runContentTimelineStep`（时间线）
  3) `runContentScoringStep`（评分）
- 提供规则兜底：`buildFallbackContentUnderstanding`。
- 将评分高能片段合并到摘要高亮/优化建议中。
- `mergeAiToLocal` 已支持使用内容理解评分刷新时间线热度。

### 2.2 后端：qwen-asr 时间戳字幕处理已接入
文件：`libraries/nestjs-libraries/src/materials/materials.analysis.service.ts`

已完成：
- `runAsrAnalysis` 请求 qwen-asr 返回 JSON，包含 `segments`（`startSec/endSec/text`）。
- 统一解析器 `parseAsrSegments`，兼容：
  - 结构化时间戳对象
  - 文本时间区间
  - 无时间戳时按句子切片兜底
- `aiDetailLayer.asr` 已持久化 `segments`。

### 2.3 前端：AI分析页展示“内容理解流水线”
文件：`apps/frontend/src/components/materials/materials-analysis-detail.component.tsx`

已完成：
- 扩展 `RemoteAnalysisPayload`，支持读取 `contentUnderstandingLayer`。
- AI分析页新增“内容理解流水线”卡片，展示：
  - Prompt版本
  - 大纲/时间线/评分来源（qwen/rule）
  - 平均分
  - 大纲主题
  - 时间线 Top5
  - 高分片段 Top5

### 2.4 前端：素材视频缓存机制已接入（AI分析前置）
文件：`apps/frontend/src/components/materials/materials-media-cache.ts`

已完成：
- 使用 `CacheStorage` + `blob URL` 做媒体缓存。
- `warmMediaCache` 支持预热下载。
- 去重并发下载（`inflightBlobTasks`），避免同 URL 重复拉取。

---

## 3. 未开发 / 未完成功能（后续开发项）

### P0（建议优先）
1. 端到端回归测试与稳定性修复
- 现状：已完成核心单测回归（材料分析服务 + 分析路由）；仍需补充前端端到端场景回归。
- 目标：补齐缓存命中、多素材连续点击、失败重试等 E2E 用例。

2. AI任务并发治理（连续点击多视频）
- 现状：同素材 inflight 去重已完成；跨素材下载并发上限已完成；分析并发上限可配置已完成。
- 目标：已完成“取消接口 + 前端可视化取消”；后续可继续增强为“强中断（AbortSignal）”。

3. 缓存命中可观测性
- 现状：`cacheHit/cacheReason/cacheKey/cacheAgeSec` 已落 API，后端日志已补关键字段；命中率指标看板待建设。
- 目标：补 Prometheus/Grafana 或埋点统计，形成命中率趋势图。

### P1（价值高）
4. Prompt配置外置化（借鉴 autoclip-main）
- 现状：内容理解 Prompt 在代码中拼接。
- 目标：抽到 `prompt/*.txt`，支持按行业/语言版本切换。

5. 内容理解结果版本化
- 现状：有 `promptVersion`，但缺少 schema 迁移策略。
- 目标：新增版本升级脚本与兼容层。

6. AI分析页可视化增强（收尾）
- 现状：已实现“点击时间段跳播视频” + “按播放时间高亮” + “ASR分段搜索/折叠” + “关键帧缩略图网格” + “缩略图骨架” + “分析步骤进度条”。
- 目标：补充更强交互，包括：
  - 深层分析卡片文案全量国际化（ASR/Vision/Semantic 各字段标签）

### P2（可选）
7. 视频处理深迁移（借鉴 autoclip-main 的切片能力）
- 现状：当前项目主要做分析，不含完整剪辑流水线。
- 目标：评估引入 ffmpeg 切片、封面抽帧、合集聚类能力。

8. Celery 能力迁移评估（仅借鉴，不强绑定）
- autoclip-main 有完整 Celery 任务生态；当前项目已有自己的队列/服务体系。
- 建议：先迁“任务状态模型与步骤化进度协议”，不直接迁 Celery 运行时。

---

## 4. 完整迁移逻辑清单（从素材到AI分析）

### Step A：入口与缓存
1. 素材页点击视频 -> 进入 AI分析页。
2. 前端先执行视频缓存预热（`warmMediaCache`）。
3. 若命中缓存，直接进入 AI分析触发；未命中则等待下载完成。

### Step B：AI任务触发
4. 前端先查历史分析结果（`/materials/analysis`）。
5. 若已有有效 qwen 结果，直接展示。
6. 若无结果或需重跑，调用 `/materials/analysis/trigger` 提交任务。
7. 前端轮询 `/materials/analysis/job-status` 到完成/失败。

### Step C：后端分析流水线
8. 视觉分析（vision）
- 读取视频/封面，产出摘要、关键词、场景、关键帧。

9. 字幕分析（asr）
- 调 qwen-asr，要求返回 transcript + timestamp segments。
- 统一标准化为 `[{startSec,endSec,text}]`。

10. 语义分析（semantic）
- 汇总视觉 + 字幕，产出摘要、亮点、洞察、360画像。

11. 内容理解（三步）
- 大纲：从带时间戳字幕抽取话题结构。
- 时间线：把字幕片段归类到大纲主题并校正时间。
- 评分：给每段打分、理由、证据并提炼高能片段。

12. 合并落库
- 生成 `summaryLayer + aiDetailLayer + contentUnderstandingLayer + analysis`。
- 存入 analysisResult，供后续命中缓存。

### Step D：前端渲染与交互
13. AI分析页展示三层信息：
- 摘要层（summary）
- 细节层（vision/asr/semantic）
- 内容理解层（outline/timeline/scoring）

14. 用户可重复触发重跑，系统走“先查缓存、后触发任务”逻辑。

---

## 5. `run-keepalive.cmd` 安装与启动方式（开发必读）

### 5.1 前置安装
在 Windows 开发机确认：
- 已安装 WSL2
- 已安装并可用 `Ubuntu` 发行版（脚本默认 `WSL_DISTRO=Ubuntu`）
- 仓库路径为 `F:\postiz-app`（WSL 对应 `/mnt/f/postiz-app`）

若发行版名称不是 `Ubuntu`，请先修改 `run-keepalive.cmd` 中：
- `set "WSL_DISTRO=Ubuntu"`

### 5.2 启动命令
在仓库根目录执行：

```powershell
.\run-keepalive.cmd
```

说明：
- 该模式会重启并拉起以下服务：
  - `postiz-dev-temporal.service`
  - `postiz-dev-backend.service`
  - `postiz-dev-orchestrator.service`
  - `postiz-dev-frontend.service`
  - `postiz-dev-mediacrawler.service`
  - `postiz-dev-social-auto-upload.service`
- 命令最后 `tail -f /dev/null` 保持窗口常驻，请不要关闭该终端。

### 5.3 一次性启动（不常驻）

```powershell
.\run-keepalive.cmd --once
```

说明：
- 只拉起服务并退出当前终端，不做 keepalive。

### 5.4 开发期推荐操作
1. 终端A执行 `run-keepalive.cmd` 常驻。
2. 终端B进行代码开发、测试、日志查看。
3. 验证服务状态：

```powershell
wsl -d Ubuntu -u root -- systemctl is-active postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service postiz-dev-social-auto-upload.service
```

4. 访问地址：
- Frontend: `http://localhost:4200/auth`
- Backend: `http://localhost:3000`
- MediaCrawler: `http://localhost:8081/docs`
- Social Auto Upload: `http://localhost:5409/docs`

---

## 6. 下一阶段建议（按迭代执行）
1. 完成 P0（并发治理、缓存观测、回归测试）。
2. 做 Prompt 外置化与版本化（P1）。
3. 评估视频处理深迁移与 Celery 协议借鉴（P2）。

---

## 7. `video-analyzer-main` 迁移复评（阿里/豆包 ASR + VL）

### 7.1 结论（重新评估）
- **可行性：高（推荐推进）**
- **建议方案：分层迁移，不直接搬 Python 运行时**
  - 迁移“能力与结果结构”（抽帧、逐帧视觉分析、转写、重建总结）。
  - 不迁移 Python 技术栈本身（`opencv/faster-whisper`），避免双运行时维护成本。

### 7.2 与当前工程的匹配情况
- 当前 `materials.analysis.service.ts` 已有：
  - 视觉分析（`runVisionAnalysis`）
  - 语音分析（`runAsrAnalysis`）
  - 语义/内容理解（outline/timeline/scoring）
- `video-analyzer-main` 可直接借鉴的核心：
  - 抽关键帧（按变化分数采样）
  - 逐帧分析并保留前文上下文
  - 音频转写与最终重建描述
- 因此迁移重点不是“从0到1”，而是把当前单次视觉调用升级为“关键帧链路”。

### 7.3 供应商策略（满足“阿里或豆包”）

#### ASR（必须）
- 阿里（优先）：Qwen-ASR（OpenAI兼容/DashScope），支持句级/字级时间戳。
- 豆包（可选切换）：豆包语音“大模型录音文件识别标准版API”，异步 submit/query，返回 `utterances` 与 `words` 时间（毫秒）。

#### VL（视频理解）
- 阿里（优先）：Qwen-Omni / Qwen-VL，可做图片/视频理解。
- 豆包（可选）：方舟视觉模型接入点（Endpoint ID），默认走 `responses`（`input_image + input_text`）；优先用“关键帧图片输入”路径，规避不同模型对原始 `video_url` 支持差异。

### 7.4 迁移后的目标形态（AI分析页基础内容）
在现有“视频预览”之外，新增并固化以下基础分析块：
1. 关键帧列表（时间点 + 画面摘要 + 关键词）
2. 语音转写（全文 + 分段时间戳）
3. 融合摘要（视觉+语音）
4. 高能时间线（可点击跳转）
5. 结构化内容理解（已落地的 outline/timeline/scoring）

### 7.5 技术实现清单（建议按阶段）

#### Phase A：Provider 抽象（P0）
- 新增 Provider 层：
  - `AsrProvider`：`aliyun_qwen_asr` / `doubao_asr`
  - `VisionProvider`：`aliyun_vl` / `doubao_vl`
- 新增环境变量（示例）：
  - `MATERIALS_ASR_PROVIDER=aliyun|doubao`
  - `MATERIALS_VL_PROVIDER=aliyun|doubao`
  - `MATERIALS_VL_FRAME_EXTRACTOR=true|false`（默认 true）
  - `MATERIALS_VL_FRAME_MAX_COUNT=6`（2-12）
  - `MATERIALS_VL_FRAME_TIMEOUT_MS=20000`
  - `MATERIALS_VL_FRAME_PROBE_TIMEOUT_MS=12000`
  - `ALIYUN_DASHSCOPE_API_KEY`
  - `DOUBAO_APP_ID`, `DOUBAO_ACCESS_TOKEN`, `DOUBAO_ASR_RESOURCE_ID`
  - `DOUBAO_ARK_API_KEY`, `DOUBAO_ARK_BASE_URL`, `DOUBAO_ARK_ENDPOINT_ID`

#### Phase B：关键帧链路（P0）
- 已完成（集成在 `materials.analysis.service.ts` 中）：
  - 优先 ffmpeg 抽帧（避免引入 Node-OpenCV 依赖）
  - 输出：`frameAnalyses[{index,timestampSec,timestampLabel,summary,keywords}]`
  - `runVisionAnalysis` 已升级为“逐帧批量分析 + 汇总”。

#### Phase C：ASR 双通道（P0）
- 阿里 ASR 保持当前主链路。
- 新增豆包 ASR 适配：
  - submit -> query 轮询 -> 归一化到 `segments[{startSec,endSec,text}]`。

#### Phase D：AI页展示增强（P1）
- 在 AI 分析页新增：
  - 关键帧卡片区
  - 带时间轴的转写区
  - 融合摘要与高能片段区
- 与播放器做 seek 联动（点击片段跳播）。

### 7.6 风险与规避
- 风险1：跨供应商返回结构差异大。
  - 规避：统一内部 DTO（`VisionResult`/`AsrResult`）+ 归一化层。
- 风险2：豆包视觉模型不同接入点能力差异。
  - 规避：优先“关键帧图片理解”通路，视频直传作为可选增强。
- 风险3：长视频成本与时延上升。
  - 规避：限制最大帧数、按分钟采样、缓存中间结果。

### 7.7 开发与验证方式（保持 run-keepalive）
- 启动仍按：
  - `.\run-keepalive.cmd`（常驻）
  - 或 `.\run-keepalive.cmd --once`（一次性）
- 开发验证顺序：
  1. Provider 切换单测
  2. 关键帧抽取与缓存命中回归
  3. AI页展示联调
  4. 多素材并发与取消回归

### 7.8 前端近期增量（已完成）
- AI分析页已完成中英文文案统一，移除页面内残留乱码字符串。
- AI任务状态提示已统一接入 `t.*`，包括：
  - 视频缓存前置、排队、运行、失败、取消、重试等状态。
  - 队列位置提示（中文显示“排队序号”）。
- 分析结果卡片（AI总结/内容理解/360画像/ASR/Vision/Semantic）已统一改为 `t.*` 文案。
- `renderRawText` 空态文案改为 i18n 文案，避免硬编码英文。
- 步骤进度条（视频缓存/排队/流水线/完成）标签改为 i18n 文案来源。
- 新增“跨素材会话隔离”机制：
  - 切换素材或重新触发分析时会递增 `sessionId`。
  - 历史异步请求（轮询/触发/取消）若非当前会话，结果将被丢弃，避免旧素材状态回写到新页面。
- 当视频仍处于缓存下载阶段（尚未进入AI排队/运行）时，AI页会展示统一进度卡片，不再显示“暂无结果”空态。
- AI分析页新增并发可视化信息：
  - 展示任务通道（新建任务 / 复用进行中 / 复用已存在）。
  - 展示排队序号（若后端返回 `queuePosition`）。
  - 在进度卡片中以标签形式显示上述信息。
- AI失败态已细化：
  - 新增失败原因分类（无视频、缓存失败、状态查询失败、结果不可用、取消、任务失败、超时、启动失败等）。
  - 失败卡片展示“失败原因 + 建议操作”，并根据取消态自动将按钮文案切为“重新AI分析”。

### 7.9 本轮交付（2026-03-08，按“前三项”推进）
- 前端流程 E2E 回归（脚本版）已补齐：
  - 新增：`scripts/materials-ai-frontend-e2e.js`
  - 覆盖场景：
    1) 缓存命中路径（query + trigger）
    2) 连续点击同素材的复用/排队行为
    3) 取消后重试路径
  - 运行方式：
    - 先 `.\run-keepalive.cmd --once`
    - 再执行：
      `AUTH_TOKEN=xxx MATERIAL_E2E_VIDEO_URL=https://... node scripts/materials-ai-frontend-e2e.js`
- 缓存可观测性看板已落到 AI分析页：
  - 新增“缓存命中看板”卡片，展示命中率、cache/fresh、复用、取消、并发、更新时间。
  - 提供手动刷新按钮，并按状态自动轮询刷新（分析中更高频）。
- Prompt 外置化已落地（内容理解 + 语义摘要）：
  - 新增目录：`libraries/nestjs-libraries/src/materials/prompts/`
  - 已外置模板：
    - `content-outline.prompt.txt`
    - `content-timeline.prompt.txt`
    - `content-scoring.prompt.txt`
    - `semantic-360.prompt.txt`
  - 新增环境变量：
    - `MATERIALS_PROMPT_DIR`（模板目录覆盖）
    - `MATERIALS_CONTENT_PROMPT_VERSION`（版本号，默认 `autoclip-migrated-v2`）
    - `DOUBAO_SECRET_TOKEN` / `DOUBAO_ASR_SECRET_TOKEN`（可选，豆包 ASR Secret Token）
    - `DOUBAO_ASR_AUDIO_FORMAT`（可选，手工覆盖 ASR 音频格式）
  - 缺模板时自动回落到内置 prompt，并输出 warning 日志。

### 7.10 本轮增强（2026-03-08，继续“前三项”）
- 并发治理补强（P0-2）：
  - `materials.analysis.queue.service.ts` 新增“同素材入队锁”（Redis NX + EX + 重试等待）。
  - 解决高并发 `force=true` 下同素材可能竞态重复入队的问题，确保同一稳定键优先复用。
  - 新增可调参数：
    - `MATERIALS_ANALYSIS_ENQUEUE_LOCK_TTL_SEC`（默认 8）
    - `MATERIALS_ANALYSIS_ENQUEUE_LOCK_WAIT_MS`（默认 1500）
    - `MATERIALS_ANALYSIS_ENQUEUE_LOCK_RETRY_MS`（默认 80）
- 缓存可观测性补强（P0-3）：
  - `/materials/analysis/metrics` 新增 `history[]` 命中率序列返回。
  - 后端新增 `appendMetricsHistory/getMetricsHistory`，支持 Redis 与内存模式。
  - AI分析页“缓存命中看板”新增趋势折线，显示最近 24 个采样点命中率变化。
  - 新增可调参数：
    - `MATERIALS_ANALYSIS_METRICS_HISTORY_MAX`（默认 240）
    - `MATERIALS_ANALYSIS_METRICS_HISTORY_TTL_SEC`（默认 604800）
- 回归脚本补强（P0-1）：
  - `scripts/materials-ai-frontend-e2e.js` 的多次点击场景升级为可配置并发压测：
    - `MATERIAL_E2E_MULTI_CLICK_REQUESTS`（默认 6）
  - 新增断言：唯一 `jobId`、最多一个 `queueReason=new`、必须出现复用信号。

### 7.11 豆包 VL `responses` 接口接入（2026-03-08）
- 已将豆包视觉理解主链路切换为 Ark `POST /responses`（默认）。
  - 请求体采用 `input=[{role:'user',content:[{type:'input_image'},{type:'input_text'}]}]` 结构。
  - 默认模型读取 `DOUBAO_VL_MODEL`（可配置为 `doubao-seed-2-0-mini-260215` 等）。
- 兼容策略：
  - 若 `responses` 链路异常，会自动回退 `chat/completions`，避免中断。
  - 视频场景仍优先走“关键帧抽取 + 图片理解”；`video_url` 直连由 `DOUBAO_VL_ALLOW_VIDEO_URL` 控制。
- 新增/更新环境变量：
  - `DOUBAO_VL_API_MODE=responses|chat`（默认 `responses`）
  - `DOUBAO_VL_RESPONSES_URL`（可选覆盖）
  - `DOUBAO_VL_CHAT_URL`（可选覆盖）
- 测试：
  - 单测已覆盖 `responses` 结构解析（`output_text` 与 `output[].content[].text/output_text`）。
  - 已完成真实接口连通测试（`/responses` 返回 `status=completed`）。

### 7.12 豆包 LLM `chat/completions` 接口接入（2026-03-08）
- 已将“语义分析 + 内容理解”的 LLM 调用抽象为可切换 Provider：
  - `MATERIALS_LLM_PROVIDER=qwen|doubao`（默认 `qwen`）
- 豆包 LLM 链路（按 Ark `chat/completions`）：
  - 默认地址：`https://ark.cn-beijing.volces.com/api/v3/chat/completions`
  - 鉴权：`Authorization: Bearer <DOUBAO_LLM_API_KEY>`
  - 默认模型：`doubao-1-5-pro-32k-250115`
- 新增环境变量：
  - `DOUBAO_LLM_API_KEY`
  - `DOUBAO_LLM_BASE_URL`
  - `DOUBAO_LLM_MODEL`
  - `DOUBAO_SEMANTIC_MODEL`（可选覆盖语义模型）
  - `DOUBAO_CONTENT_MODEL`（可选覆盖内容理解模型）
- 兼容策略：
  - 未配置豆包 LLM 时保持原 Qwen 行为；
  - 若两者都缺失，走现有规则兜底。
