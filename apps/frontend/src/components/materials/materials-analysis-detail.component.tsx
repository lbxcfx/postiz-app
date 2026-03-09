'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useFireEvents } from '@gitroom/helpers/utils/use.fire.events';
import {
  findMaterialFromDataset,
  loadMaterialDataset,
} from '@gitroom/frontend/components/materials/materials-analysis.storage';
import { AnalysisLayerResult } from '@gitroom/frontend/components/materials/materials-analysis.engine';
import {
  useCachedMediaUrl,
  warmMediaCache,
} from '@gitroom/frontend/components/materials/materials-media-cache';
import styles from '@gitroom/frontend/components/materials/materials-analysis-detail.module.scss';

type RemoteAnalysisPayload = {
  source?: 'qwen' | 'rule';
  analysis?: AnalysisLayerResult;
  summaryLayer?: {
    oneSentenceSummary?: string;
    highlights?: string[];
    optimizationSuggestions?: string[];
  };
  aiDetailLayer?: {
    vision?: {
      frameAnalyses?: Array<{
        index?: number;
        timestampSec?: number;
        timestampLabel?: string;
        thumbnailUrl?: string;
        summary?: string;
        keywords?: string[];
      }>;
      modelUsed?: string;
      confidence?: number;
      mediaUrl?: string;
      mediaType?: 'video' | 'image' | 'unknown';
      summary?: string;
      keywords?: string[];
      scenes?: string[];
      keyframes?: string[];
      rawText?: string;
    };
    asr?: {
      modelUsed?: string;
      confidence?: number;
      audioSource?: string;
      transcript?: string;
      language?: string;
      emotion?: string;
      segments?: Array<{
        startSec?: number;
        endSec?: number;
        text?: string;
      }>;
      rawText?: string;
    };
    semantic?: {
      modelUsed?: string;
      confidence?: number;
      summary?: string;
      highlights?: string[];
      keywords?: string[];
      insights?: string[];
      tone?: string;
      fullSummary360?: string;
      profile360?: {
        speakingFormat?: string;
        narratorRole?: string;
        productionApproach?: string[];
        expressionStyle?: string[];
        persuasionPath?: string[];
        authoritySignals?: string[];
        complianceSignals?: string[];
        audienceFit?: string[];
        risks?: string[];
        reusableAngles?: string[];
      };
      rawText?: string;
    };
  };
  contentUnderstandingLayer?: {
    promptVersion?: string;
    outline?: {
      source?: 'qwen' | 'rule';
      items?: Array<{
        id?: string;
        title?: string;
        summary?: string;
        keywords?: string[];
      }>;
      rawText?: string;
    };
    timeline?: {
      source?: 'qwen' | 'rule';
      segments?: Array<{
        id?: string;
        outlineId?: string;
        outlineTitle?: string;
        startSec?: number;
        endSec?: number;
        text?: string;
        keywords?: string[];
      }>;
      rawText?: string;
    };
    scoring?: {
      source?: 'qwen' | 'rule';
      averageScore?: number;
      segments?: Array<{
        id?: string;
        outlineTitle?: string;
        startSec?: number;
        endSec?: number;
        score?: number;
        reason?: string;
        evidence?: string[];
        isHighEnergy?: boolean;
      }>;
      topSegments?: Array<{
        id?: string;
        outlineTitle?: string;
        startSec?: number;
        endSec?: number;
        score?: number;
        reason?: string;
        evidence?: string[];
        isHighEnergy?: boolean;
      }>;
      rawText?: string;
    };
  };
};

type AiState = 'idle' | 'checking' | 'queued' | 'running' | 'succeeded' | 'failed';
type VideoCacheState = 'idle' | 'downloading' | 'ready' | 'failed' | 'missing_video';
type StepStatus = 'pending' | 'running' | 'done' | 'failed';
type AiFailureReason =
  | 'none'
  | 'missing_video'
  | 'cache_failed'
  | 'status_query_failed'
  | 'result_unusable'
  | 'cancelled'
  | 'task_failed'
  | 'historical_incomplete'
  | 'timeout'
  | 'start_failed';

const needsProxy = (url: string): boolean => {
  if (!url) return false;
  const proxyDomains = [
    'xhscdn.com',
    'xiaohongshu.com',
    'douyinpic.com',
    'douyinvod.com',
    'byteimg.com',
    'pstatp.com',
  ];
  try {
    const parsed = new URL(url);
    return proxyDomains.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
};

const getProxiedUrl = (url: string | undefined, platform: string, backendUrl: string): string => {
  if (!url || !needsProxy(url) || !backendUrl) return url || '';
  const encodedUrl = encodeURIComponent(url);
  return `${backendUrl}/materials/image-proxy?url=${encodedUrl}&platform=${platform}`;
};

const isVideoUrl = (url?: string) => {
  if (!url) return false;
  return /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);
};

const formatNumber = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (value >= 10000) return `${(value / 10000).toFixed(1)}w`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
};

const formatSecondRange = (start?: number, end?: number) => {
  const toLabel = (value?: number) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '--:--';
    const total = Math.max(0, Math.floor(value));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  return `${toLabel(start)}-${toLabel(end)}`;
};

const stripTimestampPrefix = (text: string) =>
  String(text || '')
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/g, '')
    .trim();

const inferModelProvider = (modelUsed?: string): 'doubao' | 'qwen' | 'rule' | 'unknown' => {
  const value = String(modelUsed || '')
    .trim()
    .toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('doubao') || value.includes('ark')) return 'doubao';
  if (value.includes('qwen') || value.includes('dashscope')) return 'qwen';
  if (value.includes('local') || value.includes('rule') || value.includes('heuristic'))
    return 'rule';
  return 'unknown';
};

export const MaterialsAnalysisDetail = () => {
  const fetch = useFetch();
  const fireEvents = useFireEvents();
  const { backendUrl } = useVariables();
  const router = useRouter();
  const params = useParams();
  const rawId = params?.id;
  const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : '';

  const [aiState, setAiState] = useState<AiState>('idle');
  const [aiJobId, setAiJobId] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  const [aiFailureReason, setAiFailureReason] = useState<AiFailureReason>('none');
  const [aiQueueReason, setAiQueueReason] = useState('');
  const [aiQueuePosition, setAiQueuePosition] = useState<number | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<RemoteAnalysisPayload | null>(null);
  const [aiCancelling, setAiCancelling] = useState(false);
  const [currentPreviewSecond, setCurrentPreviewSecond] = useState<number | null>(
    null
  );
  const [asrQuery, setAsrQuery] = useState('');
  const [asrExpanded, setAsrExpanded] = useState(false);
  const [loadedFrameThumbs, setLoadedFrameThumbs] = useState<Record<string, boolean>>({});
  const autoTriggeredRef = useRef(false);
  const activeSessionRef = useRef(0);
  const isMountedRef = useRef(true);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const prevAiStateRef = useRef<AiState>('idle');
  const prevVideoCacheStateRef = useRef<VideoCacheState>('idle');
  const analysisTimingRef = useRef<{
    analysisStartMs: number | null;
    cacheStartMs: number | null;
    cacheReadyMs: number | null;
    queuedAtMs: number | null;
    runningAtMs: number | null;
    loggedCacheReady: boolean;
    loggedQueued: boolean;
    loggedRunning: boolean;
  }>({
    analysisStartMs: null,
    cacheStartMs: null,
    cacheReadyMs: null,
    queuedAtMs: null,
    runningAtMs: null,
    loggedCacheReady: false,
    loggedQueued: false,
    loggedRunning: false,
  });

  const backToMaterials = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/materials');
  };

  const isSessionActive = useCallback(
    (sessionId: number) => isMountedRef.current && sessionId === activeSessionRef.current,
    []
  );

  const isZh = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return true;
    }
    const langs = [navigator.language, ...(navigator.languages || [])]
      .filter(Boolean)
      .map((entry) => String(entry).toLowerCase());
    return langs.some((entry) => entry.startsWith('zh'));
  }, []);
  const t = useMemo(
    () =>
      isZh
        ? {
            emptyNotFound: '未找到这条爆款素材，请先在素材页抓取并点击“查看分析”进入详情。',
            backToMaterials: '返回素材页',
            openSource: '打开原帖',
            analysisSourceReady: '千问AI',
            analysisSourceRunning: 'AI分析中...',
            analysisSourceIdle: 'AI分析',
            analysisSourceLabel: '分析来源',
            videoCacheStateLabel: '视频缓存状态',
            metricsDashboardTitle: '缓存命中看板',
            metricsRefresh: '刷新看板',
            metricsLoading: '看板加载中...',
            metricsLoadFailed: '看板加载失败',
            metricsTrendTitle: '缓存命中率趋势（最近）',
            metricsTrendEmpty: '暂无趋势数据',
            metricsHitRate: '缓存命中率',
            metricsWorkerCacheHit: 'Worker缓存命中',
            metricsWorkerFreshRun: 'Worker新跑',
            metricsEnqueuedNew: '新建入队',
            metricsReusedInflight: '复用进行中',
            metricsReusedExisting: '复用已存在',
            metricsCancelRequested: '运行中取消请求',
            metricsCancelQueued: '队列取消',
            metricsCancelled: '已取消总数',
            metricsQueueConcurrency: '分析并发',
            metricsDownloadConcurrency: '下载并发',
            metricsGeneratedAt: '更新时间',
            noVideoForAnalysis: '无视频可分析',
            noMediaPreview: '暂无可预览素材',
            videoDownloading: '视频下载中...',
            aiAnalyzing: 'AI分析中...',
            retryAi: '重试AI分析',
            rerunAi: '重新AI分析',
            noData: '暂无',
            unknown: '未知',
            untitledMaterial: '未命名素材',
            externalIdLabel: '外部ID',
            previewTitle: '素材预览',
            metricsLabel: '点赞 / 收藏 / 评论 / 转发',
            publishTime: '发布时间',
            analyzingHint: '正在调用千问进行语音、画面和语义分析，请稍候...',
            taskId: '任务ID',
            seekHint: '点击跳转到该时间点',
            seekDisabled: '当前素材无可跳播视频',
            cachePreparing: '正在下载视频并写入缓存，完成后自动开始AI分析...',
            transientRetry: 'AI任务状态查询波动，正在自动重试...',
            runningHint: 'AI正在分析中...',
            continuingQuery: '正在继续查询AI任务状态...',
            checkingCache: '正在检查AI分析缓存...',
            incompleteRerun: '检测到历史AI结果不完整，正在重跑分析...',
            startingTask: '正在启动AI分析任务...',
            videoCacheReady: '视频缓存已就绪',
            videoCacheDownloading: '视频下载中...',
            videoCacheFailed: '视频缓存失败',
            videoCacheMissing: '当前素材无可用视频',
            videoCachePending: '视频缓存待处理',
            stepCache: '视频缓存',
            stepQueue: '排队等待',
            stepPipeline: 'AI分析流水线',
            stepDone: '完成',
            aiSummaryTitle: 'AI总结',
            aiSummaryFallback: '暂无一句话总结',
            coreHighlights: '核心亮点',
            optimizationSuggestions: '优化建议',
            contentPipelineTitle: '内容理解流水线',
            promptVersion: 'Prompt版本',
            sourceTriplet: '大纲/时间线/评分来源',
            avgSegmentScore: '平均片段分',
            outlineTopics: '大纲主题',
            outlineFallback: '暂无大纲主题',
            topicDefault: '主题',
            timelineTop5: '时间线片段（Top5）',
            timelineFallback: '暂无时间线片段',
            scoringTop5: '评分高能片段（Top5）',
            scoringFallback: '暂无评分片段',
            uncategorized: '未分类',
            scoreUnit: '分',
            highEnergy: '高能',
            profileTitle: '360内容画像',
            speakingFormat: '口播形式',
            narratorRole: '主播角色',
            productionApproach: '制作方式',
            expressionStyle: '表达风格',
            persuasionPath: '说服路径',
            authoritySignals: '权威信号',
            complianceSignals: '合规信号',
            audienceFit: '适配人群',
            risks: '风险点',
            reusableAngles: '可复用角度',
            summary360: '360度总结',
            summary360Fallback: '暂无360度总结，建议重试AI分析。',
            asrTitle: '语音ASR原始结果',
            model: '模型',
            provider: '提供商',
            providerDoubao: '豆包',
            providerQwen: '千问',
            providerRule: '规则兜底',
            providerUnknown: '未知',
            confidence: '置信度',
            audioSource: '音频来源',
            langEmotion: '语言 / 情绪',
            transcript: '转写文本',
            asrSegments: '时间戳分段',
            asrSearchPlaceholder: '搜索ASR分段关键词',
            clear: '清空',
            asrCollapse: '收起到前10段',
            asrExpand: '展开全部分段',
            asrHitPrefix: '命中',
            asrHitMiddle: '段，当前展示',
            asrHitSuffix: '段',
            modelRawOutput: '模型原始输出',
            rawOutputFallback: '暂无模型原始输出',
            visionTitle: '视觉/VL原始结果',
            mediaType: '媒体类型',
            mediaUrl: '媒体URL',
            visionSummary: '视觉总结',
            keywords: '关键词',
            scenes: '场景识别',
            keyframes: '关键帧描述',
            keyframeThumbnails: '关键帧与对应分析',
            keyframeThumbEmpty: '当前结果暂无关键帧缩略图，可重试AI分析重新生成。',
            keyframeAnalysisTop6: '关键帧分析（Top6）',
            keyframeAnalysisEmpty: '暂无关键帧分析',
            semanticTitle: '语义LLM原始结果',
            tone: '语气',
            semanticSummary: '语义总结',
            highlights: '亮点',
            insights: '洞察建议',
            summary360Raw: '360度总结原文',
            queueModeLabel: '任务通道',
            queueModeFresh: '新建任务',
            queueModeReuseInflight: '复用进行中任务',
            queueModeReuseExisting: '复用已存在任务',
            queueModeUnknown: '队列任务',
            queuePositionLabel: '排队序号',
            queueReuseInflight: '（复用进行中的同素材任务）',
            queueReuseExisting: '（复用已存在任务）',
            queuedMessage: 'AI任务排队中...',
            runningMessage: 'AI正在分析中...',
            noVideoCannotStart: '当前素材没有可分析视频，无法启动AI分析。',
            videoDownloadFailed: '视频下载失败，无法继续AI分析。',
            queryStatusFailed: '查询AI任务状态失败，请重试AI分析。',
            finishedNoUsableResult: 'AI分析完成，但未返回可用的千问结果，请重试。',
            taskCancelled: 'AI任务已取消。',
            taskFailedRetry: 'AI分析失败，请重试。',
            historicalIncompleteClickRetry: '历史AI结果不完整，请点击“重试AI分析”。',
            takesLonger: 'AI分析耗时较长，请稍后重试或继续等待。',
            startFailed: '启动AI分析失败，请稍后重试。',
            cancelRequestSubmitted: '取消请求已提交，当前运行步骤可能仍会完成。',
            cancelFailed: '取消AI任务失败，请重试。',
            cancelTask: '取消AI任务',
            cancelling: '取消中...',
            failedTitle: 'AI分析失败',
            noResultTitle: '暂无AI分析结果',
            noResultHint: '正在准备AI分析结果，可点击“重试AI分析”触发。',
            failureReasonLabel: '失败原因',
            failureHintLabel: '建议操作',
            failureHintMissingVideo: '素材无可分析视频，请返回素材页更换或补充视频后重试。',
            failureHintCacheFailed: '视频缓存失败，建议先确认网络/源地址可访问后重试。',
            failureHintStatusFailed: '任务状态查询失败，建议稍后重试并观察队列状态。',
            failureHintResultUnusable: 'AI返回结果不完整，建议点击“重试AI分析”重跑。',
            failureHintCancelled: '任务已取消，可直接重新发起AI分析。',
            failureHintTaskFailed: '任务执行失败，建议重试；若持续失败请检查后端日志。',
            failureHintHistoricalIncomplete: '检测到历史结果不完整，建议强制重跑分析。',
            failureHintTimeout: '任务耗时较长，可继续等待或稍后重试。',
            failureHintStartFailed: '任务启动失败，请检查服务与配置后重试。',
            failureHintDefault: '请点击“重试AI分析”再次尝试。',
          }
        : {
            emptyNotFound: 'Material not found. Please crawl it on Materials page and open analysis.',
            backToMaterials: 'Back to Materials',
            openSource: 'Open Source Post',
            analysisSourceReady: 'Qwen AI',
            analysisSourceRunning: 'AI analyzing...',
            analysisSourceIdle: 'AI Analysis',
            analysisSourceLabel: 'Analysis source',
            videoCacheStateLabel: 'Video cache state',
            metricsDashboardTitle: 'Cache Hit Dashboard',
            metricsRefresh: 'Refresh',
            metricsLoading: 'Dashboard loading...',
            metricsLoadFailed: 'Dashboard load failed',
            metricsTrendTitle: 'Cache Hit Rate Trend',
            metricsTrendEmpty: 'No trend data',
            metricsHitRate: 'Cache hit rate',
            metricsWorkerCacheHit: 'Worker cache hit',
            metricsWorkerFreshRun: 'Worker fresh run',
            metricsEnqueuedNew: 'New enqueued',
            metricsReusedInflight: 'Reused inflight',
            metricsReusedExisting: 'Reused existing',
            metricsCancelRequested: 'Running cancel requests',
            metricsCancelQueued: 'Queued cancelled',
            metricsCancelled: 'Cancelled total',
            metricsQueueConcurrency: 'Analysis concurrency',
            metricsDownloadConcurrency: 'Download concurrency',
            metricsGeneratedAt: 'Updated at',
            noVideoForAnalysis: 'No video for analysis',
            noMediaPreview: 'No media available for preview',
            videoDownloading: 'Video downloading...',
            aiAnalyzing: 'AI analyzing...',
            retryAi: 'Retry AI analysis',
            rerunAi: 'Rerun AI analysis',
            noData: 'No data',
            unknown: 'unknown',
            untitledMaterial: 'Untitled Material',
            externalIdLabel: 'External ID',
            previewTitle: 'Material Preview',
            metricsLabel: 'Likes / Favorites / Comments / Shares',
            publishTime: 'Published At',
            analyzingHint: 'Analyzing audio, visuals and semantics. This may take a while...',
            taskId: 'Task ID',
            seekHint: 'Click to seek this timestamp',
            seekDisabled: 'Current material has no seekable video',
            cachePreparing: 'Downloading and caching video. AI analysis will start automatically...',
            transientRetry: 'Task status request had a transient error, retrying automatically...',
            runningHint: 'AI is analyzing...',
            continuingQuery: 'Resuming AI task status polling...',
            checkingCache: 'Checking AI cache...',
            incompleteRerun: 'Historical AI result is incomplete, rerunning analysis...',
            startingTask: 'Starting AI analysis task...',
            videoCacheReady: 'Video cache ready',
            videoCacheDownloading: 'Video downloading...',
            videoCacheFailed: 'Video cache failed',
            videoCacheMissing: 'No video available',
            videoCachePending: 'Video cache pending',
            stepCache: 'Video cache',
            stepQueue: 'Queue',
            stepPipeline: 'AI pipeline',
            stepDone: 'Completed',
            aiSummaryTitle: 'AI Summary',
            aiSummaryFallback: 'No one-sentence summary yet',
            coreHighlights: 'Core Highlights',
            optimizationSuggestions: 'Optimization Suggestions',
            contentPipelineTitle: 'Content Understanding Pipeline',
            promptVersion: 'Prompt Version',
            sourceTriplet: 'Outline / Timeline / Scoring Source',
            avgSegmentScore: 'Average Segment Score',
            outlineTopics: 'Outline Topics',
            outlineFallback: 'No outline topics',
            topicDefault: 'Topic',
            timelineTop5: 'Timeline Segments (Top5)',
            timelineFallback: 'No timeline segments',
            scoringTop5: 'Top Scoring Segments (Top5)',
            scoringFallback: 'No scoring segments',
            uncategorized: 'Uncategorized',
            scoreUnit: 'pts',
            highEnergy: 'High Energy',
            profileTitle: '360 Content Profile',
            speakingFormat: 'Speaking Format',
            narratorRole: 'Narrator Role',
            productionApproach: 'Production Approach',
            expressionStyle: 'Expression Style',
            persuasionPath: 'Persuasion Path',
            authoritySignals: 'Authority Signals',
            complianceSignals: 'Compliance Signals',
            audienceFit: 'Audience Fit',
            risks: 'Risks',
            reusableAngles: 'Reusable Angles',
            summary360: '360 Summary',
            summary360Fallback: 'No 360 summary yet. Please retry AI analysis.',
            asrTitle: 'ASR Raw Output',
            model: 'Model',
            provider: 'Provider',
            providerDoubao: 'Doubao',
            providerQwen: 'Qwen',
            providerRule: 'Rule fallback',
            providerUnknown: 'Unknown',
            confidence: 'Confidence',
            audioSource: 'Audio Source',
            langEmotion: 'Language / Emotion',
            transcript: 'Transcript',
            asrSegments: 'Timestamp Segments',
            asrSearchPlaceholder: 'Search ASR segments',
            clear: 'Clear',
            asrCollapse: 'Collapse to top 10',
            asrExpand: 'Expand all segments',
            asrHitPrefix: 'Matched',
            asrHitMiddle: 'segments, showing',
            asrHitSuffix: 'segments',
            modelRawOutput: 'Raw Model Output',
            rawOutputFallback: 'No raw model output',
            visionTitle: 'Vision/VL Raw Output',
            mediaType: 'Media Type',
            mediaUrl: 'Media URL',
            visionSummary: 'Vision Summary',
            keywords: 'Keywords',
            scenes: 'Scenes',
            keyframes: 'Keyframes',
            keyframeThumbnails: 'Keyframes with Analysis',
            keyframeThumbEmpty:
              'No keyframe thumbnails in current result. Retry AI analysis to regenerate frame snapshots.',
            keyframeAnalysisTop6: 'Keyframe Analysis (Top6)',
            keyframeAnalysisEmpty: 'No keyframe analysis',
            semanticTitle: 'Semantic LLM Raw Output',
            tone: 'Tone',
            semanticSummary: 'Semantic Summary',
            highlights: 'Highlights',
            insights: 'Insights',
            summary360Raw: '360 Summary Raw Text',
            queueModeLabel: 'Task channel',
            queueModeFresh: 'New task',
            queueModeReuseInflight: 'Reuse inflight task',
            queueModeReuseExisting: 'Reuse existing task',
            queueModeUnknown: 'Queued task',
            queuePositionLabel: 'Queue position',
            queueReuseInflight: '(Reusing inflight task for the same material)',
            queueReuseExisting: '(Reusing existing task)',
            queuedMessage: 'AI task is queued...',
            runningMessage: 'AI is analyzing...',
            noVideoCannotStart: 'Current material has no analyzable video, AI analysis cannot start.',
            videoDownloadFailed: 'Video download failed, AI analysis cannot proceed.',
            queryStatusFailed: 'Failed to query AI task status, please retry AI analysis.',
            finishedNoUsableResult:
              'AI analysis finished, but no usable qwen result was returned. Please retry.',
            taskCancelled: 'AI task cancelled.',
            taskFailedRetry: 'AI analysis failed, please retry.',
            historicalIncompleteClickRetry:
              'Historical AI result is incomplete. Please click "Retry AI analysis".',
            takesLonger: 'AI analysis is taking longer than expected. Retry later or keep waiting.',
            startFailed: 'Failed to start AI analysis. Please retry later.',
            cancelRequestSubmitted:
              'Cancel request submitted. Current running step may still finish.',
            cancelFailed: 'Failed to cancel AI task. Please retry.',
            cancelTask: 'Cancel AI Task',
            cancelling: 'Cancelling...',
            failedTitle: 'AI analysis failed',
            noResultTitle: 'No AI analysis result yet',
            noResultHint: 'Preparing AI result. Click "Retry AI analysis" to trigger again.',
            failureReasonLabel: 'Failure reason',
            failureHintLabel: 'Suggested action',
            failureHintMissingVideo:
              'Current material has no analyzable video. Switch material or provide a valid video first.',
            failureHintCacheFailed: 'Video cache failed. Check network/source accessibility and retry.',
            failureHintStatusFailed: 'Task status query failed. Retry later and check queue state.',
            failureHintResultUnusable: 'AI result is incomplete. Retry AI analysis to rerun.',
            failureHintCancelled: 'Task was cancelled. You can rerun AI analysis directly.',
            failureHintTaskFailed: 'Task execution failed. Retry; if persistent, check backend logs.',
            failureHintHistoricalIncomplete:
              'Historical result is incomplete. A forced rerun is recommended.',
            failureHintTimeout: 'Task is taking longer than expected. Keep waiting or retry later.',
            failureHintStartFailed: 'Failed to start task. Check service/config and retry.',
            failureHintDefault: 'Click "Retry AI analysis" to try again.',
          },
    [isZh]
  );
  const dataset = useMemo(() => loadMaterialDataset(), []);
  const item = useMemo(() => findMaterialFromDataset(id), [id, dataset]);
  const rawVideoUrl = item && isVideoUrl(item.contentUrl) ? item.contentUrl : '';
  const previewMediaUrl = item
    ? getProxiedUrl(rawVideoUrl || item.coverUrl, item.platform, backendUrl)
    : '';
  const analysisVideoUrl = item
    ? getProxiedUrl(rawVideoUrl, item.platform, backendUrl)
    : '';
  const hasVideoForAnalysis = Boolean(rawVideoUrl);
  const [videoCacheState, setVideoCacheState] = useState<VideoCacheState>('idle');
  const videoCacheTaskRef = useRef<Promise<boolean> | null>(null);
  const cachedMediaUrl = useCachedMediaUrl(previewMediaUrl, Boolean(previewMediaUrl));
  const fireMaterialEvent = useCallback(
    (name: string, props?: Record<string, unknown>) => {
      fireEvents(name, {
        page: 'materials_ai_analysis',
        routeId: id || '',
        platform: item?.platform || '',
        externalId: item?.externalId || '',
        ...(props || {}),
      });
    },
    [fireEvents, id, item?.externalId, item?.platform]
  );

  const hasAiPayloadContent = (payload?: RemoteAnalysisPayload | null) =>
    Boolean(
      payload &&
        (payload.analysis ||
          payload.summaryLayer ||
          payload.aiDetailLayer ||
          payload.contentUnderstandingLayer)
    );

  const shouldForceRefreshAi = (payload?: RemoteAnalysisPayload | null) => {
    if (!payload || payload.source !== 'qwen') return false;
    const visionRaw = String(payload.aiDetailLayer?.vision?.rawText || '').toLowerCase();
    const asrRaw = String(payload.aiDetailLayer?.asr?.rawText || '').toLowerCase();
    const semanticRaw = String(payload.aiDetailLayer?.semantic?.rawText || '').toLowerCase();
    const isFallback = (text: string) =>
      text.includes('fallback:') || text.includes('timeout after') || text.includes('this operation was aborted');
    return isFallback(visionRaw) || isFallback(asrRaw) || isFallback(semanticRaw);
  };

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  useEffect(() => {
    activeSessionRef.current += 1;
    autoTriggeredRef.current = false;
    setAiState('idle');
    setAiJobId(null);
    setAiMessage('');
    setAiFailureReason('none');
    setAiQueueReason('');
    setAiQueuePosition(null);
    setAiAnalysis(null);
    setAiCancelling(false);
    setCurrentPreviewSecond(null);
    setAsrQuery('');
    setAsrExpanded(false);
    setLoadedFrameThumbs({});
    prevAiStateRef.current = 'idle';
    prevVideoCacheStateRef.current = 'idle';
    analysisTimingRef.current = {
      analysisStartMs: null,
      cacheStartMs: null,
      cacheReadyMs: null,
      queuedAtMs: null,
      runningAtMs: null,
      loggedCacheReady: false,
      loggedQueued: false,
      loggedRunning: false,
    };
  }, [id]);

  useEffect(() => {
    if (!item) {
      setVideoCacheState('idle');
      videoCacheTaskRef.current = null;
      return;
    }
    if (!hasVideoForAnalysis || !analysisVideoUrl) {
      setVideoCacheState('missing_video');
      videoCacheTaskRef.current = null;
      return;
    }

    let disposed = false;
    setVideoCacheState('downloading');
    const task = warmMediaCache(analysisVideoUrl)
      .then((ready) => {
        if (!disposed) {
          setVideoCacheState(ready ? 'ready' : 'failed');
        }
        return ready;
      })
      .catch(() => {
        if (!disposed) {
          setVideoCacheState('failed');
        }
        return false;
      });
    videoCacheTaskRef.current = task;

    return () => {
      disposed = true;
    };
  }, [analysisVideoUrl, hasVideoForAnalysis, id, item]);

  useEffect(() => {
    const prev = prevVideoCacheStateRef.current;
    if (prev === videoCacheState) {
      return;
    }
    prevVideoCacheStateRef.current = videoCacheState;
    const timing = analysisTimingRef.current;
    const now = Date.now();
    if (videoCacheState === 'downloading' && !timing.cacheStartMs) {
      timing.cacheStartMs = now;
      fireMaterialEvent('materials_ai_video_cache_start');
      return;
    }
    if (videoCacheState === 'ready' && !timing.loggedCacheReady) {
      timing.loggedCacheReady = true;
      timing.cacheReadyMs = now;
      fireMaterialEvent('materials_ai_video_cache_ready', {
        costMs: timing.cacheStartMs ? Math.max(0, now - timing.cacheStartMs) : undefined,
      });
      return;
    }
    if (videoCacheState === 'failed') {
      fireMaterialEvent('materials_ai_video_cache_failed', {
        costMs: timing.cacheStartMs ? Math.max(0, now - timing.cacheStartMs) : undefined,
      });
    }
  }, [fireMaterialEvent, videoCacheState]);

  useEffect(() => {
    const prev = prevAiStateRef.current;
    if (prev === aiState) {
      return;
    }
    prevAiStateRef.current = aiState;
    const timing = analysisTimingRef.current;
    const now = Date.now();
    if (aiState === 'queued' && !timing.loggedQueued) {
      timing.loggedQueued = true;
      timing.queuedAtMs = now;
      fireMaterialEvent('materials_ai_task_queued');
      return;
    }
    if (aiState === 'running' && !timing.loggedRunning) {
      timing.loggedRunning = true;
      timing.runningAtMs = now;
      fireMaterialEvent('materials_ai_task_running', {
        queueWaitMs: timing.queuedAtMs ? Math.max(0, now - timing.queuedAtMs) : undefined,
      });
      return;
    }
    if (aiState === 'succeeded') {
      fireMaterialEvent('materials_ai_task_succeeded', {
        totalMs: timing.analysisStartMs ? Math.max(0, now - timing.analysisStartMs) : undefined,
        runMs: timing.runningAtMs ? Math.max(0, now - timing.runningAtMs) : undefined,
      });
      return;
    }
    if (aiState === 'failed') {
      fireMaterialEvent('materials_ai_task_failed', {
        totalMs: timing.analysisStartMs ? Math.max(0, now - timing.analysisStartMs) : undefined,
      });
    }
  }, [aiState, fireMaterialEvent]);

  const ensureVideoCacheReady = useCallback(async (sessionId: number) => {
    if (!isSessionActive(sessionId)) {
      return false;
    }
    if (!item) {
      return false;
    }
    if (!hasVideoForAnalysis || !analysisVideoUrl) {
      setAiState('failed');
      setAiFailureReason('missing_video');
      setAiMessage(t.noVideoCannotStart);
      return false;
    }
    if (videoCacheState === 'ready') {
      return true;
    }

    setAiState('checking');
    setAiMessage(t.cachePreparing);
    const currentTask =
      videoCacheTaskRef.current ||
      warmMediaCache(analysisVideoUrl).catch(() => false);
    videoCacheTaskRef.current = currentTask;
    const ready = await currentTask;
    if (!isSessionActive(sessionId)) {
      return false;
    }
    setVideoCacheState(ready ? 'ready' : 'failed');
    if (!ready) {
      setAiState('failed');
      setAiFailureReason('cache_failed');
      setAiMessage(t.videoDownloadFailed);
    }
    return ready;
  }, [
    analysisVideoUrl,
    hasVideoForAnalysis,
    item,
    t.cachePreparing,
    t.noVideoCannotStart,
    t.videoDownloadFailed,
    videoCacheState,
    isSessionActive,
  ]);

  const pollAiJob = useCallback(
    async (jobId: string, sessionId: number) => {
      if (!item || !isSessionActive(sessionId)) {
        return;
      }
      const maxAttempts = 180;
      let transientErrors = 0;
      for (let i = 0; i < maxAttempts; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!isSessionActive(sessionId)) {
          return;
        }
        let status: any;
        try {
          const statusResp = await fetch(
            `/materials/analysis/job-status?jobId=${encodeURIComponent(jobId)}`
          );
          if (!statusResp.ok) {
            throw new Error(`status ${statusResp.status}`);
          }
          status = await statusResp.json();
          transientErrors = 0;
        } catch {
          if (!isSessionActive(sessionId)) {
            return;
          }
          transientErrors += 1;
          if (transientErrors <= 8) {
            setAiState('running');
            setAiMessage(t.transientRetry);
            continue;
          }
          setAiState('failed');
          setAiFailureReason('status_query_failed');
          setAiMessage(t.queryStatusFailed);
          return;
        }
        if (!isSessionActive(sessionId)) {
          return;
        }
        if (status?.state === 'queued') {
          setAiState('queued');
          if (typeof status?.queueReason === 'string') {
            setAiQueueReason(String(status.queueReason));
          }
          setAiQueuePosition(
            typeof status?.queuePosition === 'number' && status.queuePosition > 0
              ? status.queuePosition
              : null
          );
          const position =
            typeof status?.queuePosition === 'number' && status.queuePosition > 0
              ? isZh
                ? `（排队序号 ${status.queuePosition}）`
                : ` (position ${status.queuePosition})`
              : '';
          setAiMessage(status?.message ? `${status.message}${position}` : `${t.queuedMessage}${position}`);
          continue;
        }
        if (status?.state === 'running') {
          setAiState('running');
          setAiFailureReason('none');
          setAiMessage(status?.message || t.runningHint);
          continue;
        }
        if (status?.state === 'succeeded') {
          const result = status?.result?.data as RemoteAnalysisPayload | undefined;
          if (result?.source === 'qwen' && hasAiPayloadContent(result)) {
            setAiAnalysis(result);
            setAiState('succeeded');
            setAiFailureReason('none');
            setAiMessage('');
            setAiJobId(null);
            return;
          }
          setAiState('failed');
          setAiFailureReason('result_unusable');
          setAiMessage(t.finishedNoUsableResult);
          setAiJobId(null);
          return;
        }
        if (status?.state === 'cancelled') {
          setAiState('failed');
          setAiFailureReason('cancelled');
          setAiMessage(status?.message || t.taskCancelled);
          setAiJobId(null);
          return;
        }
        if (status?.state === 'failed' || status?.state === 'missing') {
          setAiState('failed');
          setAiFailureReason('task_failed');
          setAiMessage(status?.error || status?.message || t.taskFailedRetry);
          setAiJobId(null);
          return;
        }
      }

      const routeKey = decodeURIComponent(id || '');
      const [routePlatform, routeExternalId] = routeKey.includes(':')
        ? routeKey.split(':', 2)
        : ['', ''];
      const normalizedPlatform = String(item.platform || routePlatform || '').trim().toLowerCase();
      const normalizedExternalId = String(item.externalId || routeExternalId || '').trim();
      if (normalizedPlatform && normalizedExternalId) {
        try {
          const qs = `platform=${encodeURIComponent(normalizedPlatform)}&externalId=${encodeURIComponent(
            normalizedExternalId
          )}`;
          const cachedResp = await fetch(`/materials/analysis?${qs}`);
          const cachedData = await cachedResp.json();
          if (
            cachedData?.found &&
            cachedData?.data?.source === 'qwen' &&
            hasAiPayloadContent(cachedData?.data)
          ) {
            if (!isSessionActive(sessionId)) {
              return;
            }
            if (shouldForceRefreshAi(cachedData.data)) {
              setAiState('failed');
              setAiFailureReason('historical_incomplete');
              setAiMessage(t.historicalIncompleteClickRetry);
              setAiJobId(null);
              return;
            }
            fireMaterialEvent('materials_ai_cache_hit', {
              layer: 'post_poll_check',
              cacheHit: cachedData?.cacheHit,
              cacheReason: cachedData?.cacheReason,
            });
            setAiAnalysis(cachedData.data);
            setAiState('succeeded');
            setAiFailureReason('none');
            setAiMessage('');
            setAiJobId(null);
            return;
          }
        } catch {
          // Ignore final cache check errors.
        }
      }
      setAiState('failed');
      setAiFailureReason('timeout');
      setAiMessage(t.takesLonger);
    },
    [
      fetch,
      fireMaterialEvent,
      isZh,
      id,
      isSessionActive,
      item,
      t.finishedNoUsableResult,
      t.historicalIncompleteClickRetry,
      t.queryStatusFailed,
      t.queuedMessage,
      t.runningHint,
      t.takesLonger,
      t.taskCancelled,
      t.taskFailedRetry,
      t.transientRetry,
    ]
  );

  const handleAiAnalyze = useCallback(async () => {
    if (!item) return;
    fireMaterialEvent('materials_ai_analyze_click', {
      hasVideoForAnalysis,
      videoCacheState,
      aiState,
    });
    const aiInProgress = aiState === 'checking' || aiState === 'queued' || aiState === 'running';
    if (aiInProgress) return;
    const sessionId = activeSessionRef.current + 1;
    activeSessionRef.current = sessionId;
    setAiFailureReason('none');
    analysisTimingRef.current.analysisStartMs = Date.now();
    if (!(await ensureVideoCacheReady(sessionId)) || !isSessionActive(sessionId)) {
      return;
    }

    if (aiAnalysis?.source === 'qwen' && hasAiPayloadContent(aiAnalysis) && !shouldForceRefreshAi(aiAnalysis)) {
      fireMaterialEvent('materials_ai_cache_hit', { layer: 'memory' });
      setAiState('succeeded');
      setAiFailureReason('none');
      setAiMessage('');
      setAiQueueReason('');
      setAiQueuePosition(null);
      return;
    }

    if (aiJobId && aiState === 'failed') {
      setAiState('running');
      setAiMessage(t.continuingQuery);
      await pollAiJob(aiJobId, sessionId);
      return;
    }

    setAiState('checking');
    setAiMessage(t.checkingCache);
    setAiJobId(null);
    setAiQueueReason('');
    setAiQueuePosition(null);

    try {
      const routeKey = decodeURIComponent(id || '');
      const [routePlatform, routeExternalId] = routeKey.includes(':')
        ? routeKey.split(':', 2)
        : ['', ''];
      const normalizedPlatform = String(item.platform || routePlatform || '').trim().toLowerCase();
      const normalizedExternalId = String(item.externalId || routeExternalId || '').trim();
      if (!normalizedPlatform || !normalizedExternalId) {
        throw new Error('missing material platform/externalId');
      }

      const qs = `platform=${encodeURIComponent(normalizedPlatform)}&externalId=${encodeURIComponent(
        normalizedExternalId
      )}`;
      let forceRefresh = Boolean(aiAnalysis && shouldForceRefreshAi(aiAnalysis));
      const cachedResp = await fetch(`/materials/analysis?${qs}`);
      const cachedData = await cachedResp.json();
      if (!isSessionActive(sessionId)) {
        return;
      }
      if (
        cachedData?.found &&
        cachedData?.data?.source === 'qwen' &&
        hasAiPayloadContent(cachedData?.data)
      ) {
        if (!shouldForceRefreshAi(cachedData.data)) {
          fireMaterialEvent('materials_ai_cache_hit', {
            layer: 'analysis_api',
            cacheHit: cachedData?.cacheHit,
            cacheReason: cachedData?.cacheReason,
          });
          setAiAnalysis(cachedData.data);
          setAiState('succeeded');
          setAiFailureReason('none');
          setAiMessage('');
          return;
        }
        forceRefresh = true;
        setAiMessage(t.incompleteRerun);
      }

      setAiMessage(t.startingTask);
      fireMaterialEvent('materials_ai_cache_miss', {
        layer: 'analysis_api',
        cacheHit: cachedData?.cacheHit,
        cacheReason: cachedData?.cacheReason,
      });
      const triggerResp = await fetch('/materials/analysis/trigger', {
        method: 'POST',
        body: JSON.stringify({
          item: {
            platform: normalizedPlatform,
            externalId: normalizedExternalId,
            title: item.title,
            desc: item.desc,
            coverUrl: item.coverUrl,
            contentUrl: item.contentUrl,
            authorName: item.authorName,
            authorUserId: item.authorUserId,
            createdAt: item.createdAt,
            likedCount: item.likedCount,
            collectedCount: item.collectedCount,
            commentCount: item.commentCount,
            shareCount: item.shareCount,
            followerCount: item.followerCount,
          },
          force: forceRefresh,
        }),
      });
      if (!triggerResp.ok) {
        const text = await triggerResp.text();
        throw new Error(text || `HTTP ${triggerResp.status}`);
      }
      const triggerData = await triggerResp.json();
      if (!isSessionActive(sessionId)) {
        return;
      }

      if (
        triggerData?.found &&
        triggerData?.data?.source === 'qwen' &&
        hasAiPayloadContent(triggerData?.data)
      ) {
        if (!shouldForceRefreshAi(triggerData.data)) {
          fireMaterialEvent('materials_ai_cache_hit', {
            layer: 'trigger_short_circuit',
            cacheHit: triggerData?.cacheHit,
            cacheReason: triggerData?.cacheReason,
          });
          setAiAnalysis(triggerData.data);
          setAiState('succeeded');
          setAiFailureReason('none');
          setAiMessage('');
          return;
        }
        setAiMessage(t.incompleteRerun);
      }

      if (triggerData?.accepted && triggerData?.jobId) {
        const nextJobId = String(triggerData.jobId);
        setAiJobId(nextJobId);
        setAiState(triggerData?.state === 'running' ? 'running' : 'queued');
        setAiQueueReason(String(triggerData?.queueReason || ''));
        setAiQueuePosition(
          typeof triggerData?.queuePosition === 'number' && triggerData.queuePosition > 0
            ? triggerData.queuePosition
            : null
        );
        fireMaterialEvent('materials_ai_job_accepted', {
          jobId: nextJobId,
          state: triggerData?.state || 'queued',
          queueReason: triggerData?.queueReason || '',
          queuePosition:
            typeof triggerData?.queuePosition === 'number'
              ? triggerData.queuePosition
              : null,
        });
        const queueReason = String(triggerData?.queueReason || '');
        const queuePosition =
          typeof triggerData?.queuePosition === 'number' && triggerData.queuePosition > 0
            ? isZh
              ? `（排队序号 ${triggerData.queuePosition}）`
              : ` (position ${triggerData.queuePosition})`
            : '';
        const queueHint =
          queueReason === 'inflight'
            ? t.queueReuseInflight
            : queueReason === 'existing'
            ? t.queueReuseExisting
            : '';
        setAiMessage(
          triggerData?.state === 'running'
            ? `${t.runningMessage}${queueHint}`
            : `${t.queuedMessage}${queueHint}${queuePosition}`
        );
        await pollAiJob(nextJobId, sessionId);
        return;
      }

      throw new Error('AI task creation failed');
    } catch {
      if (!isSessionActive(sessionId)) {
        return;
      }
      setAiState('failed');
      setAiFailureReason('start_failed');
      setAiMessage(t.startFailed);
    }
  }, [
    aiAnalysis,
    aiJobId,
    aiState,
    ensureVideoCacheReady,
    fetch,
    fireMaterialEvent,
    hasVideoForAnalysis,
    id,
    isSessionActive,
    isZh,
    item,
    pollAiJob,
    videoCacheState,
    t.checkingCache,
    t.continuingQuery,
    t.incompleteRerun,
    t.queueReuseExisting,
    t.queueReuseInflight,
    t.queuedMessage,
    t.runningMessage,
    t.startFailed,
    t.startingTask,
  ]);

  const handleCancelAiJob = useCallback(async () => {
    if (!aiJobId || aiCancelling) {
      return;
    }
    const sessionId = activeSessionRef.current + 1;
    activeSessionRef.current = sessionId;
    fireMaterialEvent('materials_ai_cancel_click', { jobId: aiJobId });
    setAiCancelling(true);
    try {
      const cancelResp = await fetch('/materials/analysis/cancel', {
        method: 'POST',
        body: JSON.stringify({
          jobId: aiJobId,
        }),
      });
      if (!cancelResp.ok) {
        const text = await cancelResp.text();
        throw new Error(text || `HTTP ${cancelResp.status}`);
      }
      const cancelData = await cancelResp.json();
      if (!isSessionActive(sessionId)) {
        return;
      }
      setAiJobId(null);
      setAiState('failed');
      setAiFailureReason('cancelled');
      if (cancelData?.state === 'cancelled') {
        fireMaterialEvent('materials_ai_cancelled', { jobId: aiJobId });
        setAiMessage(cancelData?.message || t.taskCancelled);
      } else {
        fireMaterialEvent('materials_ai_cancel_requested', { jobId: aiJobId });
        setAiMessage(cancelData?.message || t.cancelRequestSubmitted);
      }
    } catch {
      if (!isSessionActive(sessionId)) {
        return;
      }
      fireMaterialEvent('materials_ai_cancel_failed', { jobId: aiJobId });
      setAiFailureReason('task_failed');
      setAiMessage(t.cancelFailed);
    } finally {
      if (isSessionActive(sessionId)) {
        setAiCancelling(false);
      }
    }
  }, [
    aiCancelling,
    aiJobId,
    fetch,
    fireMaterialEvent,
    isSessionActive,
    t.cancelFailed,
    t.cancelRequestSubmitted,
    t.taskCancelled,
  ]);

  useEffect(() => {
    if (!item || autoTriggeredRef.current) {
      return;
    }
    if (!hasVideoForAnalysis) {
      autoTriggeredRef.current = true;
      fireMaterialEvent('materials_ai_missing_video');
      setAiState('failed');
      setAiFailureReason('missing_video');
      setAiMessage(t.noVideoCannotStart);
      return;
    }
    if (videoCacheState !== 'ready') {
      return;
    }
    autoTriggeredRef.current = true;
    fireMaterialEvent('materials_ai_auto_trigger');
    void handleAiAnalyze();
  }, [
    fireMaterialEvent,
    handleAiAnalyze,
    hasVideoForAnalysis,
    item,
    t.noVideoCannotStart,
    videoCacheState,
  ]);

  if (!item) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.empty}>{t.emptyNotFound}</div>
          <div className={styles.actions}>
            <button className={styles.button} onClick={backToMaterials}>
              {t.backToMaterials}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const aiInProgress = aiState === 'checking' || aiState === 'queued' || aiState === 'running';
  const hasAiResult = aiState === 'succeeded' && !!aiAnalysis;
  const showCachePreparing = !hasAiResult && !aiInProgress && videoCacheState === 'downloading';
  const sourceLabel = hasAiResult
    ? t.analysisSourceReady
    : aiInProgress
    ? t.analysisSourceRunning
    : t.analysisSourceIdle;
  const mediaUrl = previewMediaUrl;
  const noteUrl =
    item.platform === 'xhs'
      ? `https://www.xiaohongshu.com/explore/${item.externalId}`
      : item.contentUrl || item.coverUrl || '';
  const aiVision = aiAnalysis?.aiDetailLayer?.vision;
  const aiAsr = aiAnalysis?.aiDetailLayer?.asr;
  const aiSemantic = aiAnalysis?.aiDetailLayer?.semantic;
  const asrProvider = inferModelProvider(aiAsr?.modelUsed);
  const visionProvider = inferModelProvider(aiVision?.modelUsed);
  const semanticProvider = inferModelProvider(aiSemantic?.modelUsed);
  const providerToLabel = (provider: 'doubao' | 'qwen' | 'rule' | 'unknown') =>
    provider === 'doubao'
      ? t.providerDoubao
      : provider === 'qwen'
      ? t.providerQwen
      : provider === 'rule'
      ? t.providerRule
      : t.providerUnknown;
  const aiProfile = aiSemantic?.profile360;
  const aiContentUnderstanding = aiAnalysis?.contentUnderstandingLayer;
  const aiFrameAnalyses = aiVision?.frameAnalyses || [];
  const aiFramePairs = useMemo(() => {
    const keyframes = Array.isArray(aiVision?.keyframes) ? aiVision.keyframes : [];
    if (aiFrameAnalyses.length) {
      return aiFrameAnalyses.slice(0, 12).map((frame, index) => {
        const fallbackLabel =
          frame.timestampLabel || formatSecondRange(frame.timestampSec, frame.timestampSec);
        const keyframeTextRaw = String(keyframes[index] || '').trim();
        const keyframeText = keyframeTextRaw || `[${fallbackLabel}] ${frame.summary || ''}`.trim();
        return {
          index: frame.index || index + 1,
          timestampSec: frame.timestampSec,
          timestampLabel: fallbackLabel,
          thumbnailUrl: String(frame.thumbnailUrl || '').trim(),
          summary: frame.summary || stripTimestampPrefix(keyframeText) || '-',
          keywords: Array.isArray(frame.keywords) ? frame.keywords : [],
          keyframeText,
        };
      });
    }

    return keyframes.slice(0, 12).map((entry, index) => {
      const raw = String(entry || '').trim();
      const tsMatch = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      return {
        index: index + 1,
        timestampSec: undefined as number | undefined,
        timestampLabel: tsMatch?.[1] || '--:--',
        thumbnailUrl: '',
        summary: stripTimestampPrefix(raw) || '-',
        keywords: [] as string[],
        keyframeText: raw || `#${index + 1}`,
      };
    });
  }, [aiFrameAnalyses, aiVision?.keyframes]);
  const frameThumbResetKey = useMemo(
    () =>
      aiFramePairs
        .map(
          (frame) =>
            `${frame.index || 0}_${frame.timestampSec || 0}_${String(frame.thumbnailUrl || '').slice(0, 32)}`
        )
        .join('|'),
    [aiFramePairs]
  );
  const aiAsrSegments = aiAsr?.segments || [];
  const normalizedAsrQuery = asrQuery.trim().toLowerCase();
  const filteredAsrSegments = useMemo(() => {
    if (!normalizedAsrQuery) {
      return aiAsrSegments;
    }
    return aiAsrSegments.filter((segment) =>
      String(segment.text || '')
        .toLowerCase()
        .includes(normalizedAsrQuery)
    );
  }, [aiAsrSegments, normalizedAsrQuery]);
  const visibleAsrSegments = asrExpanded
    ? filteredAsrSegments
    : filteredAsrSegments.slice(0, 10);
  const canExpandAsrSegments = filteredAsrSegments.length > 10;
  const aiOutlineItems = aiContentUnderstanding?.outline?.items || [];
  const aiTimelineSegments = aiContentUnderstanding?.timeline?.segments || [];
  const aiTopScoringSegments = aiContentUnderstanding?.scoring?.topSegments || [];
  const hasSeekablePreview = Boolean(isVideoUrl(item.contentUrl));
  const aiTriggerDisabled =
    aiInProgress || videoCacheState === 'downloading' || !hasVideoForAnalysis;
  const aiCancelDisabled = !aiJobId || aiCancelling;
  const videoCacheLabel =
    videoCacheState === 'ready'
      ? t.videoCacheReady
      : videoCacheState === 'downloading'
      ? t.videoCacheDownloading
      : videoCacheState === 'failed'
      ? t.videoCacheFailed
      : videoCacheState === 'missing_video'
      ? t.videoCacheMissing
      : t.videoCachePending;
  const aiActionLabel = !hasVideoForAnalysis
    ? t.noVideoForAnalysis
    : videoCacheState === 'downloading'
    ? t.videoDownloading
    : aiInProgress
    ? t.aiAnalyzing
    : aiState === 'failed'
    ? aiFailureReason === 'cancelled'
      ? t.rerunAi
      : t.retryAi
    : t.rerunAi;
  const queueModeLabel =
    aiQueueReason === 'inflight'
      ? t.queueModeReuseInflight
      : aiQueueReason === 'existing'
      ? t.queueModeReuseExisting
      : aiQueueReason
      ? t.queueModeUnknown
      : t.queueModeFresh;
  const showQueueMeta = aiInProgress || Boolean(aiQueueReason) || Boolean(aiQueuePosition);
  const failureReasonText =
    aiFailureReason === 'missing_video'
      ? t.noVideoCannotStart
      : aiFailureReason === 'cache_failed'
      ? t.videoDownloadFailed
      : aiFailureReason === 'status_query_failed'
      ? t.queryStatusFailed
      : aiFailureReason === 'result_unusable'
      ? t.finishedNoUsableResult
      : aiFailureReason === 'cancelled'
      ? t.taskCancelled
      : aiFailureReason === 'task_failed'
      ? t.taskFailedRetry
      : aiFailureReason === 'historical_incomplete'
      ? t.historicalIncompleteClickRetry
      : aiFailureReason === 'timeout'
      ? t.takesLonger
      : aiFailureReason === 'start_failed'
      ? t.startFailed
      : '';
  const failureHintText =
    aiFailureReason === 'missing_video'
      ? t.failureHintMissingVideo
      : aiFailureReason === 'cache_failed'
      ? t.failureHintCacheFailed
      : aiFailureReason === 'status_query_failed'
      ? t.failureHintStatusFailed
      : aiFailureReason === 'result_unusable'
      ? t.failureHintResultUnusable
      : aiFailureReason === 'cancelled'
      ? t.failureHintCancelled
      : aiFailureReason === 'task_failed'
      ? t.failureHintTaskFailed
      : aiFailureReason === 'historical_incomplete'
      ? t.failureHintHistoricalIncomplete
      : aiFailureReason === 'timeout'
      ? t.failureHintTimeout
      : aiFailureReason === 'start_failed'
      ? t.failureHintStartFailed
      : t.failureHintDefault;
  const renderTags = (items?: string[]) => {
    if (!Array.isArray(items) || !items.length) {
      return <span className={styles.subtitle}>{t.noData}</span>;
    }
    return (
      <div className={styles.tags}>
        {items.map((tag, idx) => (
          <span key={`${tag}_${idx}`} className={styles.tag}>
            {tag}
          </span>
        ))}
      </div>
    );
  };

  const renderRawText = (text?: string) => {
    if (!text) {
      return <p className={styles.subtitle}>{t.rawOutputFallback}</p>;
    }
    return (
      <div className={styles.rawBlock}>
        <pre className={styles.rawText}>{text}</pre>
      </div>
    );
  };

  const seekPreviewTo = useCallback((second?: number, source = 'unknown') => {
    if (second === null || second === undefined || Number.isNaN(second)) {
      return;
    }
    const video = previewVideoRef.current;
    if (!video) {
      return;
    }
    const target = Math.max(0, Number(second));
    fireMaterialEvent('materials_ai_seek_preview', {
      source,
      targetSec: target,
    });
    video.currentTime = target;
    setCurrentPreviewSecond(target);
    void video.play().catch(() => undefined);
  }, [fireMaterialEvent]);

  const isSegmentActive = useCallback(
    (startSec?: number, endSec?: number) => {
      if (currentPreviewSecond === null || Number.isNaN(currentPreviewSecond)) {
        return false;
      }
      if (startSec === null || startSec === undefined || Number.isNaN(startSec)) {
        return false;
      }
      const normalizedStart = Math.max(0, Number(startSec));
      const normalizedEnd =
        endSec === null || endSec === undefined || Number.isNaN(endSec)
          ? normalizedStart + 1
          : Math.max(normalizedStart, Number(endSec));
      const pad = 0.35;
      return (
        currentPreviewSecond >= normalizedStart - pad &&
        currentPreviewSecond <= normalizedEnd + pad
      );
    },
    [currentPreviewSecond]
  );

  const getLineButtonClassName = useCallback(
    (active: boolean) =>
      active ? `${styles.lineButton} ${styles.lineButtonActive}` : styles.lineButton,
    []
  );

  useEffect(() => {
    setLoadedFrameThumbs({});
  }, [frameThumbResetKey, id]);

  const analysisProgressPercent = useMemo(() => {
    if (aiState === 'succeeded') return 100;
    if (aiState === 'failed') return 100;
    if (aiState === 'running') return 80;
    if (aiState === 'queued') return 50;
    if (aiState === 'checking') return videoCacheState === 'ready' ? 32 : 18;
    if (videoCacheState === 'ready') return 25;
    if (videoCacheState === 'downloading') return 12;
    return 0;
  }, [aiState, videoCacheState]);

  const analysisSteps = useMemo(
    (): Array<{ key: string; label: string; status: StepStatus }> => {
      const cacheStatus: StepStatus =
        videoCacheState === 'failed'
          ? 'failed'
          : videoCacheState === 'ready'
          ? 'done'
          : videoCacheState === 'downloading' || aiState === 'checking'
          ? 'running'
          : 'pending';
      const queueStatus: StepStatus =
        aiState === 'queued'
          ? 'running'
          : aiState === 'running' || aiState === 'succeeded' || aiState === 'failed'
          ? 'done'
          : 'pending';
      const pipelineStatus: StepStatus =
        aiState === 'running'
          ? 'running'
          : aiState === 'succeeded'
          ? 'done'
          : aiState === 'failed'
          ? 'failed'
          : 'pending';
      const doneStatus: StepStatus =
        aiState === 'succeeded' ? 'done' : aiState === 'failed' ? 'failed' : 'pending';
      return [
        { key: 'cache', label: t.stepCache, status: cacheStatus },
        { key: 'queue', label: t.stepQueue, status: queueStatus },
        { key: 'pipeline', label: t.stepPipeline, status: pipelineStatus },
        { key: 'done', label: t.stepDone, status: doneStatus },
      ];
    },
    [aiState, t.stepCache, t.stepDone, t.stepPipeline, t.stepQueue, videoCacheState]
  );

  const getStepClassName = useCallback(
    (status: StepStatus) => {
      if (status === 'done') return `${styles.stepItem} ${styles.stepDone}`;
      if (status === 'running') return `${styles.stepItem} ${styles.stepRunning}`;
      if (status === 'failed') return `${styles.stepItem} ${styles.stepFailed}`;
      return styles.stepItem;
    },
    []
  );

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>{item.title || t.untitledMaterial}</h1>
            <p className={styles.subtitle}>
              {item.platform.toUpperCase()} / {item.authorName || t.unknown} / {t.externalIdLabel}: {item.externalId}
            </p>
            <p className={styles.subtitle}>
              {t.analysisSourceLabel}: {sourceLabel}
            </p>
            <p className={styles.subtitle}>
              {t.videoCacheStateLabel}: {videoCacheLabel}
            </p>
            {showQueueMeta ? (
              <p className={styles.subtitle}>
                {t.queueModeLabel}: {queueModeLabel}
                {aiQueuePosition ? ` / ${t.queuePositionLabel}: #${aiQueuePosition}` : ''}
              </p>
            ) : null}
            {aiMessage ? <p className={styles.subtitle}>{aiMessage}</p> : null}
          </div>
          <div className={styles.actions}>
            <button className={styles.button} onClick={handleAiAnalyze} disabled={aiTriggerDisabled}>
              {aiActionLabel}
            </button>
            {aiInProgress && aiJobId ? (
              <button
                className={styles.buttonGhost}
                onClick={handleCancelAiJob}
                disabled={aiCancelDisabled}
              >
                {aiCancelling ? t.cancelling : t.cancelTask}
              </button>
            ) : null}
            {noteUrl ? (
              <button className={styles.buttonGhost} onClick={() => window.open(noteUrl, '_blank')}>
                {t.openSource}
              </button>
            ) : null}
            <button className={styles.button} onClick={backToMaterials}>
              {t.backToMaterials}
            </button>
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <h3 className={styles.layerTitle}>{t.previewTitle}</h3>
        <div className={styles.mediaBox}>
          {mediaUrl ? (
            isVideoUrl(item.contentUrl) ? (
              <video
                className={styles.media}
                src={cachedMediaUrl || mediaUrl}
                controls
                muted
                playsInline
                preload="metadata"
                ref={previewVideoRef}
                onTimeUpdate={(event) => {
                  setCurrentPreviewSecond(event.currentTarget.currentTime || 0);
                }}
                onSeeked={(event) => {
                  setCurrentPreviewSecond(event.currentTarget.currentTime || 0);
                }}
              />
            ) : (
              <img
                className={styles.media}
                src={cachedMediaUrl || mediaUrl}
                alt={item.title || 'material'}
                loading="lazy"
              />
            )
          ) : (
            <span className={styles.subtitle}>{t.noMediaPreview}</span>
          )}
        </div>
        <div className={styles.line}>
          <span>{t.metricsLabel}</span>
          <span>
            {formatNumber(item.likedCount)} / {formatNumber(item.collectedCount)} /{' '}
            {formatNumber(item.commentCount)} / {formatNumber(item.shareCount)}
          </span>
        </div>
        <div className={styles.line}>
          <span>{t.publishTime}</span>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {aiInProgress || showCachePreparing ? (
        <div className={styles.card}>
          <div className={styles.aiStatusCard}>
            <div className={styles.aiSpinner} />
            <h3 className={styles.layerTitle}>{showCachePreparing ? t.videoDownloading : t.aiAnalyzing}</h3>
            <p className={styles.subtitle}>
              {showCachePreparing ? t.cachePreparing : aiMessage || t.analyzingHint}
            </p>
            {showQueueMeta ? (
              <div className={styles.statusMetaRow}>
                <span className={styles.statusPill}>{`${t.queueModeLabel}: ${queueModeLabel}`}</span>
                {aiQueuePosition ? (
                  <span className={styles.statusPill}>{`${t.queuePositionLabel}: #${aiQueuePosition}`}</span>
                ) : null}
              </div>
            ) : null}
            <div className={styles.analysisProgress}>
              <div className={styles.progressTrack}>
                <span
                  className={styles.progressFill}
                  style={{ width: `${analysisProgressPercent}%` }}
                />
              </div>
              <p className={styles.progressMeta}>{analysisProgressPercent}%</p>
              <div className={styles.stepList}>
                {analysisSteps.map((step) => (
                  <div key={step.key} className={getStepClassName(step.status)}>
                    <span className={styles.stepDot} />
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
            </div>
            {aiJobId ? <p className={styles.subtitle}>{`${t.taskId}: ${aiJobId}`}</p> : null}
          </div>
        </div>
      ) : hasAiResult && aiAnalysis ? (
        <>
          <div className={styles.card}>
            <h3 className={styles.layerTitle}>{t.aiSummaryTitle}</h3>
            <p className={styles.subtitle}>
              {aiAnalysis.summaryLayer?.oneSentenceSummary || aiSemantic?.summary || t.aiSummaryFallback}
            </p>
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.coreHighlights}
            </div>
            {renderTags(aiAnalysis.summaryLayer?.highlights || aiSemantic?.highlights)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.optimizationSuggestions}
            </div>
            {renderTags(aiAnalysis.summaryLayer?.optimizationSuggestions || aiSemantic?.insights)}
          </div>

          <div className={styles.card}>
            <h3 className={styles.layerTitle}>{t.contentPipelineTitle}</h3>
            <div className={styles.line}>
              <span>{t.promptVersion}</span>
              <strong>{aiContentUnderstanding?.promptVersion || '-'}</strong>
            </div>
            <div className={styles.line}>
              <span>{t.sourceTriplet}</span>
              <strong>
                {(aiContentUnderstanding?.outline?.source || '-') +
                  ' / ' +
                  (aiContentUnderstanding?.timeline?.source || '-') +
                  ' / ' +
                  (aiContentUnderstanding?.scoring?.source || '-')}
              </strong>
            </div>
            <div className={styles.line}>
              <span>{t.avgSegmentScore}</span>
              <strong>{aiContentUnderstanding?.scoring?.averageScore ?? '-'}</strong>
            </div>
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.outlineTopics}
            </div>
            {aiOutlineItems.length ? (
              <div className={styles.tags}>
                {aiOutlineItems.slice(0, 8).map((entry, index) => (
                  <span className={styles.tag} key={`${entry.id || 'outline'}_${index}`}>
                    {entry.title || `${t.topicDefault}${index + 1}`}
                  </span>
                ))}
              </div>
            ) : (
              <p className={styles.subtitle}>{t.outlineFallback}</p>
            )}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.timelineTop5}
            </div>
            {aiTimelineSegments.length ? (
              <div>
                {aiTimelineSegments.slice(0, 5).map((segment, index) => (
                  <button
                    type="button"
                    className={getLineButtonClassName(
                      isSegmentActive(segment.startSec, segment.endSec)
                    )}
                    key={`${segment.id || 'timeline'}_${index}`}
                    onClick={() => seekPreviewTo(segment.startSec, 'timeline_top')}
                    disabled={!hasSeekablePreview}
                    title={hasSeekablePreview ? t.seekHint : t.seekDisabled}
                  >
                    <span>
                      {formatSecondRange(segment.startSec, segment.endSec)} /{' '}
                      {segment.outlineTitle || t.uncategorized}
                    </span>
                    <strong>{segment.text || '-'}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.subtitle}>{t.timelineFallback}</p>
            )}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.scoringTop5}
            </div>
            {aiTopScoringSegments.length ? (
              <div>
                {aiTopScoringSegments.slice(0, 5).map((segment, index) => (
                  <button
                    type="button"
                    className={getLineButtonClassName(
                      isSegmentActive(segment.startSec, segment.endSec)
                    )}
                    key={`${segment.id || 'score'}_${index}`}
                    onClick={() => seekPreviewTo(segment.startSec, 'scoring_top')}
                    disabled={!hasSeekablePreview}
                    title={hasSeekablePreview ? t.seekHint : t.seekDisabled}
                  >
                    <span>
                      {formatSecondRange(segment.startSec, segment.endSec)} /{' '}
                      {segment.outlineTitle || t.uncategorized}
                    </span>
                    <strong>
                      {`${segment.score ?? '-'} ${t.scoreUnit}`}{' '}
                      {segment.isHighEnergy ? ` / ${t.highEnergy}` : ''}
                    </strong>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.subtitle}>{t.scoringFallback}</p>
            )}
          </div>
          <div className={styles.card}>
            <h3 className={styles.layerTitle}>{t.profileTitle}</h3>
            <div className={styles.line}>
              <span>{t.speakingFormat}</span>
              <strong>{aiProfile?.speakingFormat || t.unknown}</strong>
            </div>
            <div className={styles.line}>
              <span>{t.narratorRole}</span>
              <strong>{aiProfile?.narratorRole || t.unknown}</strong>
            </div>
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.productionApproach}
            </div>
            {renderTags(aiProfile?.productionApproach)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.expressionStyle}
            </div>
            {renderTags(aiProfile?.expressionStyle)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.persuasionPath}
            </div>
            {renderTags(aiProfile?.persuasionPath)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.authoritySignals}
            </div>
            {renderTags(aiProfile?.authoritySignals)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.complianceSignals}
            </div>
            {renderTags(aiProfile?.complianceSignals)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.audienceFit}
            </div>
            {renderTags(aiProfile?.audienceFit)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.risks}
            </div>
            {renderTags(aiProfile?.risks)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.reusableAngles}
            </div>
            {renderTags(aiProfile?.reusableAngles)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              {t.summary360}
            </div>
            <p className={styles.subtitle}>
              {aiSemantic?.fullSummary360 || t.summary360Fallback}
            </p>
          </div>

          <div className={styles.layers}>
            <div className={styles.card}>
              <h3 className={styles.layerTitle}>{t.asrTitle}</h3>
              <div className={styles.line}>
                <span>{t.model}</span>
                <strong>{aiAsr?.modelUsed || t.unknown}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.provider}</span>
                <strong>{providerToLabel(asrProvider)}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.confidence}</span>
                <strong>{aiAsr?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.audioSource}</span>
                <strong>{aiAsr?.audioSource || '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.langEmotion}</span>
                <strong>
                  {aiAsr?.language || '-'} / {aiAsr?.emotion || '-'}
                </strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.transcript}
              </div>
              {renderRawText(aiAsr?.transcript)}
              {aiAsrSegments.length ? (
                <>
                  <div className={styles.label} style={{ marginTop: 10 }}>
                    {t.asrSegments}
                  </div>
                  <div className={styles.asrToolbar}>
                    <input
                      className={styles.searchInput}
                      type="search"
                      value={asrQuery}
                      onChange={(event) => {
                        setAsrQuery(event.target.value);
                        setAsrExpanded(false);
                      }}
                      placeholder={t.asrSearchPlaceholder}
                    />
                    {asrQuery ? (
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        onClick={() => {
                          setAsrQuery('');
                          setAsrExpanded(false);
                        }}
                      >
                        {t.clear}
                      </button>
                    ) : null}
                  </div>
                  <p className={styles.subtitle}>
                    {`${t.asrHitPrefix} ${filteredAsrSegments.length} ${t.asrHitMiddle} ${visibleAsrSegments.length} ${t.asrHitSuffix}`}
                  </p>
                  <div>
                    {visibleAsrSegments.map((segment, index) => (
                      <button
                        type="button"
                        className={getLineButtonClassName(
                          isSegmentActive(segment.startSec, segment.endSec)
                        )}
                        key={`asr_${index}`}
                        onClick={() => seekPreviewTo(segment.startSec, 'asr_segment')}
                        disabled={!hasSeekablePreview}
                        title={hasSeekablePreview ? t.seekHint : t.seekDisabled}
                      >
                        <span>{formatSecondRange(segment.startSec, segment.endSec)}</span>
                        <strong>{segment.text || '-'}</strong>
                      </button>
                    ))}
                  </div>
                  {canExpandAsrSegments ? (
                    <div className={styles.asrActions}>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        onClick={() => setAsrExpanded((prev) => !prev)}
                      >
                        {asrExpanded ? t.asrCollapse : t.asrExpand}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.modelRawOutput}
              </div>
              {renderRawText(aiAsr?.rawText)}
            </div>

            <div className={styles.card}>
              <h3 className={styles.layerTitle}>{t.visionTitle}</h3>
              <div className={styles.line}>
                <span>{t.model}</span>
                <strong>{aiVision?.modelUsed || t.unknown}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.provider}</span>
                <strong>{providerToLabel(visionProvider)}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.confidence}</span>
                <strong>{aiVision?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.mediaType}</span>
                <strong>{aiVision?.mediaType || '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.mediaUrl}</span>
                <strong>{aiVision?.mediaUrl || '-'}</strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.visionSummary}
              </div>
              <p className={styles.subtitle}>{aiVision?.summary || t.noData}</p>
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.keywords}
              </div>
              {renderTags(aiVision?.keywords)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.scenes}
              </div>
              {renderTags(aiVision?.scenes)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.keyframeThumbnails}
              </div>
              {aiFramePairs.length ? (
                <div className={styles.frameGrid}>
                  {aiFramePairs.map((frame, index) => {
                    const frameKey = `pair_${frame.index || 'frame'}_${frame.timestampSec || index}_${index}`;
                    const isThumbReady = Boolean(loadedFrameThumbs[frameKey]);
                    const hasThumbnail = Boolean(frame.thumbnailUrl);
                    const canSeek =
                      hasSeekablePreview &&
                      frame.timestampSec !== null &&
                      frame.timestampSec !== undefined &&
                      !Number.isNaN(frame.timestampSec);
                    const isActive = isSegmentActive(
                      frame.timestampSec,
                      frame.timestampSec === null || frame.timestampSec === undefined
                        ? undefined
                        : frame.timestampSec + 1
                    );
                    const frameCardClassName = isActive
                      ? `${styles.frameCard} ${styles.frameCardActive}`
                      : styles.frameCard;
                    return (
                      <button
                        key={frameKey}
                        type="button"
                        className={frameCardClassName}
                        onClick={() => seekPreviewTo(frame.timestampSec, 'frame_pair')}
                        disabled={!canSeek}
                        title={canSeek ? t.seekHint : t.seekDisabled}
                      >
                        <div className={styles.frameThumbWrap}>
                          {hasThumbnail ? (
                            <>
                              {!isThumbReady ? <span className={styles.frameThumbSkeleton} /> : null}
                              <img
                                className={
                                  isThumbReady
                                    ? `${styles.frameThumb} ${styles.frameThumbReady}`
                                    : `${styles.frameThumb} ${styles.frameThumbLoading}`
                                }
                                src={String(frame.thumbnailUrl || '')}
                                alt={`frame_${frame.index || index + 1}`}
                                loading="lazy"
                                onLoad={() =>
                                  setLoadedFrameThumbs((prev) =>
                                    prev[frameKey] ? prev : { ...prev, [frameKey]: true }
                                  )
                                }
                                onError={() =>
                                  setLoadedFrameThumbs((prev) =>
                                    prev[frameKey] ? prev : { ...prev, [frameKey]: true }
                                  )
                                }
                              />
                            </>
                          ) : (
                            <span className={styles.frameThumbFallback}>{t.noData}</span>
                          )}
                          <span className={styles.frameTimeBadge}>
                            {frame.timestampLabel || formatSecondRange(frame.timestampSec, frame.timestampSec)}
                          </span>
                        </div>
                        <span className={styles.frameSummary}>{frame.summary || '-'}</span>
                        <span className={styles.frameKeyText}>{frame.keyframeText || '-'}</span>
                        {frame.keywords.length ? (
                          <span className={styles.frameKeywords}>{frame.keywords.join(' / ')}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className={styles.subtitle}>{t.keyframeAnalysisEmpty}</p>
              )}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.modelRawOutput}
              </div>
              {renderRawText(aiVision?.rawText)}
            </div>

            <div className={styles.card}>
              <h3 className={styles.layerTitle}>{t.semanticTitle}</h3>
              <div className={styles.line}>
                <span>{t.model}</span>
                <strong>{aiSemantic?.modelUsed || t.unknown}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.provider}</span>
                <strong>{providerToLabel(semanticProvider)}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.confidence}</span>
                <strong>{aiSemantic?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>{t.tone}</span>
                <strong>{aiSemantic?.tone || '-'}</strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.semanticSummary}
              </div>
              <p className={styles.subtitle}>{aiSemantic?.summary || t.noData}</p>
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.highlights}
              </div>
              {renderTags(aiSemantic?.highlights)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.keywords}
              </div>
              {renderTags(aiSemantic?.keywords)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.insights}
              </div>
              {renderTags(aiSemantic?.insights)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.summary360Raw}
              </div>
              {renderRawText(aiSemantic?.fullSummary360)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                {t.modelRawOutput}
              </div>
              {renderRawText(aiSemantic?.rawText)}
            </div>
          </div>
        </>
      ) : (
        <div className={styles.card}>
          <div className={styles.aiStatusCard}>
            <h3 className={styles.layerTitle}>{aiState === 'failed' ? t.failedTitle : t.noResultTitle}</h3>
            <p className={styles.subtitle}>{aiMessage || t.noResultHint}</p>
            {aiState === 'failed' && failureReasonText ? (
              <p className={styles.subtitle}>{`${t.failureReasonLabel}: ${failureReasonText}`}</p>
            ) : null}
            {aiState === 'failed' ? (
              <p className={styles.subtitle}>{`${t.failureHintLabel}: ${failureHintText}`}</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};


