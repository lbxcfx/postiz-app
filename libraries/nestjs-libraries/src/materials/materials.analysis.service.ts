import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

type MaterialAnalysisItem = {
  platform: string;
  externalId: string;
  title?: string;
  desc?: string;
  coverUrl?: string;
  contentUrl?: string;
  authorName?: string;
  authorUserId?: string;
  createdAt?: string;
  likedCount?: number;
  collectedCount?: number;
  commentCount?: number;
  shareCount?: number;
  followerCount?: number;
};

type LocalAnalysis = {
  parseLayer: {
    textLength: number;
    tokenCount: number;
    interactionTotal: number;
    interactionRate: number | null;
    estimatedDurationSec: number;
    hasVideo: boolean;
    hasAudioSignal: boolean;
    audio: {
      speechRate: 'slow' | 'medium' | 'fast';
      emotion: 'stable' | 'positive' | 'high_arousal';
      pauseDensity: number;
      ctaKeywords: string[];
    };
    video: {
      subtitleDensity: number;
      visualHookStrength: number;
      sceneSwitchDensity: number;
    };
  };
  featureLayer: {
    hookStrength: number;
    informationDensity: number;
    emotionStrength: number;
    conversionStrength: number;
    rhythmControl: number;
    visualSignal: number;
  };
  scoreLayer: {
    overallScore: number;
    level: 'S' | 'A' | 'B' | 'C';
    dimensions: Array<{
      id: 'hook' | 'information_density' | 'emotion' | 'conversion' | 'rhythm';
      name: string;
      score: number;
      weight: number;
      reason: string;
    }>;
    confidence: number;
  };
  tagLayer: {
    industry: string[];
    styleTags: string[];
    featureTags: string[];
    hotKeywords: string[];
  };
  timeline: Array<{
    index: number;
    startSec: number;
    endSec: number;
    heat: number;
    isHighEnergy: boolean;
    reason: string;
  }>;
};

type VisionResult = {
  frameAnalyses: Array<{
    index: number;
    timestampSec: number;
    timestampLabel: string;
    thumbnailUrl?: string;
    summary: string;
    keywords: string[];
  }>;
  modelUsed: string;
  confidence: number;
  mediaUrl: string;
  mediaType: 'video' | 'image' | 'unknown';
  summary: string;
  keywords: string[];
  scenes: string[];
  keyframes: string[];
  rawText: string;
};

type AsrResult = {
  modelUsed: string;
  confidence: number;
  audioSource: string;
  transcript: string;
  language: string;
  emotion: string;
  segments: Array<{
    startSec: number;
    endSec: number;
    text: string;
  }>;
  rawText: string;
};

type ContentOutlineItem = {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
};

type ContentTimelineSegment = {
  id: string;
  outlineId: string;
  outlineTitle: string;
  startSec: number;
  endSec: number;
  text: string;
  keywords: string[];
};

type ContentScoreSegment = {
  id: string;
  outlineId: string;
  outlineTitle: string;
  startSec: number;
  endSec: number;
  score: number;
  reason: string;
  evidence: string[];
  isHighEnergy: boolean;
};

type ContentUnderstandingLayer = {
  promptVersion: string;
  outline: {
    source: 'qwen' | 'rule';
    items: ContentOutlineItem[];
    rawText: string;
  };
  timeline: {
    source: 'qwen' | 'rule';
    segments: ContentTimelineSegment[];
    rawText: string;
  };
  scoring: {
    source: 'qwen' | 'rule';
    segments: ContentScoreSegment[];
    topSegments: ContentScoreSegment[];
    averageScore: number;
    rawText: string;
  };
};

type Profile360 = {
  speakingFormat: string;
  narratorRole: string;
  productionApproach: string[];
  expressionStyle: string[];
  persuasionPath: string[];
  authoritySignals: string[];
  complianceSignals: string[];
  audienceFit: string[];
  risks: string[];
  reusableAngles: string[];
};

type SemanticResult = {
  modelUsed: string;
  confidence: number;
  summary: string;
  highlights: string[];
  keywords: string[];
  insights: string[];
  tone: string;
  fullSummary360: string;
  profile360: Profile360;
  rawText: string;
};

type StoredPayload = {
  version: 'v2-qwen-standard';
  source: 'qwen' | 'rule';
  generatedAt: string;
  modelUsed: {
    vision: string;
    asr: string;
    semantic: string;
  };
  confidence: {
    global: number;
    vision: number;
    asr: number;
    semantic: number;
  };
  summaryLayer: {
    oneSentenceSummary: string;
    highlights: string[];
    optimizationSuggestions: string[];
    reusableScriptTemplate: string;
  };
  aiDetailLayer: {
    vision: {
      frameAnalyses: Array<{
        index: number;
        timestampSec: number;
        timestampLabel: string;
        thumbnailUrl?: string;
        summary: string;
        keywords: string[];
      }>;
      modelUsed: string;
      confidence: number;
      mediaUrl: string;
      mediaType: 'video' | 'image' | 'unknown';
      summary: string;
      keywords: string[];
      scenes: string[];
      keyframes: string[];
      rawText: string;
    };
    asr: {
      modelUsed: string;
      confidence: number;
      audioSource: string;
      transcript: string;
      language: string;
      emotion: string;
      segments: Array<{
        startSec: number;
        endSec: number;
        text: string;
      }>;
      rawText: string;
    };
    semantic: {
      modelUsed: string;
      confidence: number;
      summary: string;
      highlights: string[];
      keywords: string[];
      insights: string[];
      tone: string;
      fullSummary360: string;
      profile360: Profile360;
      rawText: string;
    };
  };
  contentUnderstandingLayer: ContentUnderstandingLayer;
  analysis: LocalAnalysis;
};

type AnalysisRunOptions = {
  signal?: AbortSignal;
};

type FetchJsonOptions = {
  signal?: AbortSignal;
};

type MaterialsAsrProvider = 'aliyun' | 'doubao';
type MaterialsVisionProvider = 'aliyun' | 'doubao';
type MaterialsLlmProvider = 'qwen' | 'doubao';
type ExtractedFrame = {
  index: number;
  timestampSec: number;
  timestampLabel: string;
  imageDataUrl: string;
};

type PreparedAsrAudio = {
  mediaSource: string;
  format: string;
  aliyunInputData: string;
  doubaoAudioData?: string;
  tempDir?: string;
};

const STOP_WORDS = new Set([
  'we',
  'you',
  'this',
  'that',
  'the',
  'and',
  'for',
  'with',
  'then',
  'because',
  'video',
  'content',
  'share',
]);

const HOOK_KEYWORDS = ['must', 'wait', '3s', 'conclusion', 'really', 'amazing', 'now'];
const CTA_KEYWORDS = ['comment', 'save', 'follow', 'dm', 'share', 'like', 'next'];
const EMOTION_KEYWORDS = ['surprise', 'shocking', 'crazy', 'love', 'wow', 'boom'];

@Injectable()
export class MaterialsAnalysisService {
  private readonly logger = new Logger(MaterialsAnalysisService.name);
  private readonly analysisType = 'material_video_analysis_v1';
  private readonly lockPrefix = 'materials:analysis:lock:';
  private readonly cancelMarker = '__CANCELLED_BY_USER__';
  private readonly promptDir =
    process.env.MATERIALS_PROMPT_DIR ||
    join(process.cwd(), 'libraries', 'nestjs-libraries', 'src', 'materials', 'prompts');
  private readonly promptTemplateCache = new Map<string, string>();
  private readonly promptTemplateWarningSet = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async getLatestAnalysis(orgId: string, platform: string, externalId: string) {
    const source = await this.prisma.sourceContent.findFirst({
      where: {
        organizationId: orgId,
        platform,
        externalId,
      },
      select: { id: true },
    });
    if (!source) {
      return null;
    }
    const row = await this.prisma.analysisResult.findFirst({
      where: {
        sourceContentId: source.id,
        type: this.analysisType,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return null;
    }
    return row.result as StoredPayload;
  }

  async analyzeAndStore(
    orgId: string,
    item: MaterialAnalysisItem,
    options?: AnalysisRunOptions
  ): Promise<StoredPayload> {
    const lockKey = `${this.lockPrefix}${orgId}:${item.platform}:${item.externalId}`;
    const lockAcquired = await ioRedis.set(lockKey, '1', 'EX', 120, 'NX');
    if (!lockAcquired) {
      const existing = await this.waitForLatestAnalysis(orgId, item.platform, item.externalId);
      if (existing) {
        return existing;
      }
      throw new Error('Analysis is already in progress');
    }

    try {
    const source = await this.prisma.sourceContent.upsert({
      where: {
        organizationId_platform_externalId: {
          organizationId: orgId,
          platform: item.platform,
          externalId: item.externalId,
        },
      },
      create: {
        organizationId: orgId,
        platform: item.platform,
        externalId: item.externalId,
        title: item.title || null,
        content: item.desc || null,
        authorName: item.authorName || null,
        authorId: item.authorUserId || null,
        publishedAt: this.safeDate(item.createdAt),
        rawPayload: item as any,
      },
      update: {
        title: item.title || null,
        content: item.desc || null,
        authorName: item.authorName || null,
        authorId: item.authorUserId || null,
        publishedAt: this.safeDate(item.createdAt),
        rawPayload: item as any,
      },
      select: { id: true },
    });

    const payload = await this.buildAnalysisPayload(item, options);
    await this.prisma.analysisResult.create({
      data: {
        sourceContentId: source.id,
        type: this.analysisType,
        modelUsed: [
          payload.modelUsed.vision,
          payload.modelUsed.asr,
          payload.modelUsed.semantic,
        ]
          .filter(Boolean)
          .join(', '),
        confidence: Number((payload.confidence.global / 100).toFixed(2)),
        result: payload as any,
      },
    });
    return payload;
    } finally {
      await ioRedis.del(lockKey);
    }
  }

  private async buildAnalysisPayload(
    item: MaterialAnalysisItem,
    options?: AnalysisRunOptions
  ): Promise<StoredPayload> {
    this.throwIfCancelled(options?.signal);
    const base = this.buildLocalAnalysis(item);
    const llmProvider = this.resolveLlmProvider();
    const llmApiKey = this.resolveLlmApiKey(llmProvider);
    const fallbackVision = this.buildVisionFallback(item, this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl));
    const fallbackAsr = this.buildAsrFallback(item, this.normalizeHttp(item.contentUrl));
    const fallbackSemantic = this.buildSemanticFallback(item, fallbackVision, fallbackAsr);
    const fallbackContentUnderstanding = this.buildFallbackContentUnderstanding(item, fallbackAsr);
    if (
      !this.hasLlmProviderConfigured() &&
      !this.hasVisionProviderConfigured() &&
      !this.hasAsrProviderConfigured()
    ) {
      return {
        version: 'v2-qwen-standard',
        source: 'rule',
        generatedAt: new Date().toISOString(),
        modelUsed: {
          vision: 'local-heuristic',
          asr: 'local-heuristic',
          semantic: 'local-heuristic',
        },
        confidence: {
          global: base.scoreLayer.confidence,
          vision: 0,
          asr: 0,
          semantic: 0,
        },
        summaryLayer: {
          oneSentenceSummary: this.shortSummary(`${item.title || ''} ${item.desc || ''}`),
          highlights: [],
          optimizationSuggestions: ['Add stronger opening hook and explicit CTA'],
          reusableScriptTemplate: 'Hook -> Value points -> Proof -> CTA',
        },
        aiDetailLayer: {
          vision: fallbackVision,
          asr: fallbackAsr,
          semantic: fallbackSemantic,
        },
        contentUnderstandingLayer: fallbackContentUnderstanding,
        analysis: base,
      };
    }

    const [vision, asr] = await Promise.all([
      this.runVisionAnalysis(item, undefined, options?.signal),
      this.runAsrAnalysis(item, undefined, options?.signal),
    ]);
    this.throwIfCancelled(options?.signal);
    const semantic = llmApiKey
      ? await this.runSemanticAnalysis(
          item,
          vision,
          asr,
          llmProvider,
          llmApiKey,
          options?.signal
        )
      : this.buildSemanticFallback(item, vision, asr, 'llm api key not configured');
    const contentUnderstanding = llmApiKey
      ? await this.runContentUnderstandingPipeline(
          item,
          asr,
          semantic,
          llmProvider,
          llmApiKey,
          options?.signal
        )
      : this.buildFallbackContentUnderstanding(item, asr);

    const merged = this.mergeAiToLocal(
      base,
      vision,
      asr,
      semantic,
      contentUnderstanding
    );
    const globalConfidence = this.avg([
      vision.confidence * 100,
      asr.confidence * 100,
      semantic.confidence * 100,
    ]);
    const scoringHighlights = contentUnderstanding.scoring.topSegments
      .slice(0, 3)
      .map(
        (segment) =>
          `[${this.formatTimeSpan(segment.startSec, segment.endSec)}] ${segment.outlineTitle} (${segment.score})`
      );
    const mergedHighlights = this.dedupeStrings([
      ...semantic.highlights.slice(0, 6),
      ...scoringHighlights,
    ]).slice(0, 8);
    const mergedSuggestions = this.dedupeStrings([
      ...semantic.insights.slice(0, 5),
      ...this.buildSuggestionsFromScoring(contentUnderstanding.scoring.segments),
    ]).slice(0, 6);

    return {
      version: 'v2-qwen-standard',
      source: 'qwen',
      generatedAt: new Date().toISOString(),
      modelUsed: {
        vision: vision.modelUsed,
        asr: asr.modelUsed,
        semantic: semantic.modelUsed,
      },
      confidence: {
        global: globalConfidence,
        vision: Math.round(vision.confidence * 100),
        asr: Math.round(asr.confidence * 100),
        semantic: Math.round(semantic.confidence * 100),
      },
      summaryLayer: {
        oneSentenceSummary: semantic.summary || vision.summary || this.shortSummary(item.desc || ''),
        highlights: mergedHighlights,
        optimizationSuggestions: mergedSuggestions,
        reusableScriptTemplate:
          'Open with a bold claim in 3s, then 3 concrete points, add proof, end with CTA',
      },
      aiDetailLayer: {
        vision: {
          frameAnalyses: vision.frameAnalyses,
          modelUsed: vision.modelUsed,
          confidence: Math.round(vision.confidence * 100),
          mediaUrl: vision.mediaUrl,
          mediaType: vision.mediaType,
          summary: vision.summary,
          keywords: vision.keywords,
          scenes: vision.scenes,
          keyframes: vision.keyframes,
          rawText: vision.rawText,
        },
        asr: {
          modelUsed: asr.modelUsed,
          confidence: Math.round(asr.confidence * 100),
          audioSource: asr.audioSource,
          transcript: asr.transcript,
          language: asr.language,
          emotion: asr.emotion,
          segments: asr.segments,
          rawText: asr.rawText,
        },
        semantic: {
          modelUsed: semantic.modelUsed,
          confidence: Math.round(semantic.confidence * 100),
          summary: semantic.summary,
          highlights: semantic.highlights,
          keywords: semantic.keywords,
          insights: semantic.insights,
          tone: semantic.tone,
          fullSummary360: semantic.fullSummary360,
          profile360: semantic.profile360,
          rawText: semantic.rawText,
        },
      },
      contentUnderstandingLayer: contentUnderstanding,
      analysis: merged,
    };
  }

  private mergeAiToLocal(
    base: LocalAnalysis,
    vision: VisionResult,
    asr: AsrResult,
    semantic: SemanticResult,
    contentUnderstanding?: ContentUnderstandingLayer
  ): LocalAnalysis {
    const copy: LocalAnalysis = JSON.parse(JSON.stringify(base));
    if (semantic.keywords.length) {
      copy.tagLayer.hotKeywords = semantic.keywords.slice(0, 8);
    }
    if (asr.emotion) {
      const em = asr.emotion.toLowerCase();
      copy.parseLayer.audio.emotion =
        em.includes('high') || em.includes('excited')
          ? 'high_arousal'
          : em.includes('positive')
          ? 'positive'
          : 'stable';
    }
    if (semantic.highlights.length) {
      copy.timeline = copy.timeline.map((seg, i) => ({
        ...seg,
        reason: semantic.highlights[i % semantic.highlights.length] || seg.reason,
      }));
    }
    if (contentUnderstanding?.scoring?.segments?.length) {
      const normalized = contentUnderstanding.scoring.segments
        .slice(0, 8)
        .sort((a, b) => a.startSec - b.startSec)
        .map((segment, index) => ({
          index: index + 1,
          startSec: Math.max(0, Math.round(segment.startSec)),
          endSec: Math.max(Math.round(segment.startSec) + 1, Math.round(segment.endSec)),
          heat: this.clamp(Math.round(segment.score), 0, 100),
          isHighEnergy: segment.isHighEnergy,
          reason: segment.reason || segment.outlineTitle,
        }));
      if (normalized.length) {
        copy.timeline = normalized;
      }
    }
    copy.scoreLayer.confidence = this.clamp(
      Math.round(this.avg([vision.confidence * 100, asr.confidence * 100, semantic.confidence * 100])),
      40,
      99
    );
    return copy;
  }

  private resolveQwenApiKey() {
    return process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  }

  private compatibleBaseUrl() {
    return (
      process.env.QWEN_BASE_URL ||
      process.env.QWEN_API_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/$/, '');
  }

  private resolveVisionProvider(): MaterialsVisionProvider {
    return process.env.MATERIALS_VL_PROVIDER === 'doubao' ? 'doubao' : 'aliyun';
  }

  private resolveAsrProvider(): MaterialsAsrProvider {
    return process.env.MATERIALS_ASR_PROVIDER === 'doubao' ? 'doubao' : 'aliyun';
  }

  private resolveLlmProvider(): MaterialsLlmProvider {
    const configured = String(process.env.MATERIALS_LLM_PROVIDER || '')
      .trim()
      .toLowerCase();
    if (configured === 'doubao') {
      return 'doubao';
    }
    if (configured === 'qwen' || configured === 'aliyun') {
      return 'qwen';
    }
    if (this.resolveQwenApiKey()) {
      return 'qwen';
    }
    if (this.resolveDoubaoLlmApiKey()) {
      return 'doubao';
    }
    return 'qwen';
  }

  private resolveLlmApiKey(provider: MaterialsLlmProvider) {
    return provider === 'doubao'
      ? this.resolveDoubaoLlmApiKey()
      : this.resolveQwenApiKey();
  }

  private resolveLlmChatEndpoint(provider: MaterialsLlmProvider) {
    return provider === 'doubao'
      ? `${this.resolveDoubaoLlmBaseUrl()}/chat/completions`
      : `${this.compatibleBaseUrl()}/chat/completions`;
  }

  private resolveSemanticModel(provider: MaterialsLlmProvider) {
    if (provider === 'doubao') {
      return (
        process.env.DOUBAO_SEMANTIC_MODEL ||
        process.env.DOUBAO_LLM_MODEL ||
        'doubao-1-5-pro-32k-250115'
      );
    }
    return process.env.QWEN_SEMANTIC_MODEL || 'qwen3.5-plus';
  }

  private resolveContentModel(provider: MaterialsLlmProvider) {
    if (provider === 'doubao') {
      return (
        process.env.DOUBAO_CONTENT_MODEL ||
        process.env.DOUBAO_LLM_MODEL ||
        process.env.DOUBAO_SEMANTIC_MODEL ||
        'doubao-1-5-pro-32k-250115'
      );
    }
    return (
      process.env.QWEN_CONTENT_MODEL ||
      process.env.QWEN_SEMANTIC_MODEL ||
      'qwen3.5-plus'
    );
  }

  private hasLlmProviderConfigured() {
    const provider = this.resolveLlmProvider();
    return Boolean(this.resolveLlmApiKey(provider));
  }

  private resolveDoubaoVlApiKey() {
    return process.env.DOUBAO_ARK_API_KEY || process.env.DOUBAO_VL_API_KEY || '';
  }

  private resolveDoubaoLlmApiKey() {
    return process.env.DOUBAO_LLM_API_KEY || process.env.DOUBAO_ARK_API_KEY || '';
  }

  private resolveDoubaoVlBaseUrl() {
    return (
      process.env.DOUBAO_ARK_BASE_URL ||
      process.env.DOUBAO_VL_BASE_URL ||
      'https://ark.cn-beijing.volces.com/api/v3'
    ).replace(/\/$/, '');
  }

  private resolveDoubaoLlmBaseUrl() {
    return (
      process.env.DOUBAO_LLM_BASE_URL ||
      process.env.DOUBAO_ARK_BASE_URL ||
      'https://ark.cn-beijing.volces.com/api/v3'
    ).replace(/\/$/, '');
  }

  private resolveDoubaoVlModel() {
    return process.env.DOUBAO_VL_MODEL || process.env.DOUBAO_ARK_ENDPOINT_ID || '';
  }

  private resolveDoubaoVlApiMode(): 'responses' | 'chat' {
    const mode = String(process.env.DOUBAO_VL_API_MODE || 'responses')
      .trim()
      .toLowerCase();
    return mode === 'chat' ? 'chat' : 'responses';
  }

  private resolveDoubaoVlResponsesUrl() {
    const configured = String(process.env.DOUBAO_VL_RESPONSES_URL || '').trim();
    if (configured) {
      return configured.replace(/\/$/, '');
    }
    return `${this.resolveDoubaoVlBaseUrl()}/responses`;
  }

  private resolveDoubaoVlChatCompletionsUrl() {
    const configured = String(process.env.DOUBAO_VL_CHAT_URL || '').trim();
    if (configured) {
      return configured.replace(/\/$/, '');
    }
    return `${this.resolveDoubaoVlBaseUrl()}/chat/completions`;
  }

  private resolveDoubaoAsrAppId() {
    return process.env.DOUBAO_APP_ID || process.env.DOUBAO_ASR_APP_ID || '';
  }

  private resolveDoubaoAsrAccessToken() {
    return process.env.DOUBAO_ACCESS_TOKEN || process.env.DOUBAO_ASR_ACCESS_TOKEN || '';
  }

  private resolveDoubaoAsrSecretToken() {
    return process.env.DOUBAO_SECRET_TOKEN || process.env.DOUBAO_ASR_SECRET_TOKEN || '';
  }

  private resolveDoubaoAsrAuthToken() {
    return this.resolveDoubaoAsrAccessToken() || this.resolveDoubaoAsrSecretToken();
  }

  private resolveDoubaoAsrResourceId() {
    return process.env.DOUBAO_ASR_RESOURCE_ID || 'volc.bigasr.auc';
  }

  private resolveDoubaoAsrSubmitUrl() {
    return (
      process.env.DOUBAO_ASR_SUBMIT_URL ||
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
    ).replace(/\/$/, '');
  }

  private resolveDoubaoAsrQueryUrl() {
    return (
      process.env.DOUBAO_ASR_QUERY_URL ||
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'
    ).replace(/\/$/, '');
  }

  private resolveDoubaoAsrPollIntervalMs() {
    return Math.max(Number(process.env.DOUBAO_ASR_POLL_INTERVAL_MS || 3000), 800);
  }

  private resolveDoubaoAsrMaxPolls() {
    return Math.max(Number(process.env.DOUBAO_ASR_MAX_POLLS || 60), 5);
  }

  private hasVisionProviderConfigured() {
    if (this.resolveVisionProvider() === 'doubao') {
      return !!(
        this.resolveDoubaoVlApiKey() &&
        this.resolveDoubaoVlBaseUrl() &&
        this.resolveDoubaoVlModel()
      );
    }
    return !!this.resolveQwenApiKey();
  }

  private hasAsrProviderConfigured() {
    if (this.resolveAsrProvider() === 'doubao') {
      return !!(
        this.resolveDoubaoAsrAppId() &&
        this.resolveDoubaoAsrAuthToken() &&
        this.resolveDoubaoAsrResourceId()
      );
    }
    return !!this.resolveQwenApiKey();
  }

  private hasDoubaoAsrConfig() {
    return !!(
      this.resolveDoubaoAsrAppId() &&
      this.resolveDoubaoAsrAuthToken() &&
      this.resolveDoubaoAsrResourceId()
    );
  }

  private hasAliyunAsrConfig(apiKey?: string) {
    return Boolean(apiKey || this.resolveQwenApiKey());
  }

  private isAsrHeuristicFallback(result: AsrResult) {
    return String(result?.modelUsed || '').trim().toLowerCase() === 'local-heuristic';
  }

  private resolveAsrAudioMaxSeconds() {
    return Math.max(Number(process.env.ANALYSIS_AUDIO_MAX_SECONDS || 180), 15);
  }

  private resolveAsrExtractTimeoutMs() {
    return Math.max(Number(process.env.MATERIALS_ASR_EXTRACT_TIMEOUT_MS || 90_000), 20_000);
  }

  private resolveMediaReferer(platform?: string) {
    const map: Record<string, string> = {
      xhs: 'https://www.xiaohongshu.com/',
      dy: 'https://www.douyin.com/',
      bili: 'https://www.bilibili.com/',
    };
    return map[String(platform || '').trim().toLowerCase()] || map.xhs;
  }

  private buildFfmpegHttpHeaders(platform?: string) {
    const referer = this.resolveMediaReferer(platform);
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    return `Referer: ${referer}\r\nUser-Agent: ${userAgent}\r\n`;
  }

  private async prepareAsrAudioInput(
    item: MaterialAnalysisItem,
    signal?: AbortSignal
  ): Promise<PreparedAsrAudio | null> {
    const mediaSource = this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl);
    if (!mediaSource) {
      return null;
    }

    const fallbackFormat = this.detectAudioFormat(mediaSource);
    const workdir = join(tmpdir(), `materials-asr-${randomUUID()}`);
    const outputPath = join(workdir, `audio-${randomUUID()}.wav`);
    await fs.mkdir(workdir, { recursive: true });

    try {
      this.throwIfCancelled(signal);
      const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];
      if (/^https?:\/\//i.test(mediaSource)) {
        args.push('-headers', this.buildFfmpegHttpHeaders(item.platform));
      }
      args.push(
        '-i',
        mediaSource,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-sample_fmt',
        's16',
        '-acodec',
        'pcm_s16le',
        '-t',
        String(this.resolveAsrAudioMaxSeconds()),
        outputPath
      );
      await this.execCommand('ffmpeg', args, this.resolveAsrExtractTimeoutMs(), signal);
      const buffer = await fs.readFile(outputPath);
      if (!buffer.length) {
        throw new Error('ffmpeg output is empty');
      }
      const base64 = buffer.toString('base64');
      return {
        mediaSource,
        format: 'wav',
        aliyunInputData: `data:audio/wav;base64,${base64}`,
        doubaoAudioData: base64,
        tempDir: workdir,
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`prepareAsrAudioInput fallback to original source: ${message}`);
      return {
        mediaSource,
        format: fallbackFormat,
        aliyunInputData: mediaSource,
        tempDir: workdir,
      };
    }
  }

  private async cleanupPreparedAsrAudio(prepared?: PreparedAsrAudio | null) {
    if (!prepared?.tempDir) {
      return;
    }
    await fs.rm(prepared.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private shouldUseFrameExtractor() {
    return process.env.MATERIALS_VL_FRAME_EXTRACTOR !== 'false';
  }

  private resolveFrameExtractorMaxFrames() {
    return this.clamp(
      Math.round(Number(process.env.MATERIALS_VL_FRAME_MAX_COUNT || 6)),
      2,
      12
    );
  }

  private resolveFrameExtractorTimeoutMs() {
    return Math.max(Number(process.env.MATERIALS_VL_FRAME_TIMEOUT_MS || 20_000), 5_000);
  }

  private resolveFrameProbeTimeoutMs() {
    return Math.max(Number(process.env.MATERIALS_VL_FRAME_PROBE_TIMEOUT_MS || 12_000), 3_000);
  }

  private buildFrameTimestamps(durationSec: number | null, maxFrames: number) {
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 1) {
      return Array.from({ length: maxFrames }, (_, index) => index * 3 + 1);
    }
    const safeDuration = Math.min(durationSec, 10 * 60);
    const start = Math.min(0.8, Math.max(0, safeDuration * 0.02));
    const end = Math.max(start + 0.5, safeDuration - 0.8);
    if (maxFrames <= 1 || end <= start) {
      return [start];
    }
    const step = (end - start) / (maxFrames - 1);
    return Array.from({ length: maxFrames }, (_, index) =>
      Number((start + step * index).toFixed(2))
    );
  }

  private async probeVideoDurationSec(videoUrl: string, signal?: AbortSignal) {
    try {
      const result = await this.execCommand(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          videoUrl,
        ],
        this.resolveFrameProbeTimeoutMs(),
        signal
      );
      const value = Number(String(result.stdout || '').trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`probeVideoDurationSec fallback: ${message}`);
      return null;
    }
  }

  private async extractFramesAsDataUrls(
    videoUrl: string,
    signal?: AbortSignal
  ): Promise<ExtractedFrame[]> {
    const maxFrames = this.resolveFrameExtractorMaxFrames();
    const durationSec = await this.probeVideoDurationSec(videoUrl, signal);
    const timestamps = this.buildFrameTimestamps(durationSec, maxFrames);
    const workdir = join(tmpdir(), `materials-vl-${randomUUID()}`);
    const timeoutMs = this.resolveFrameExtractorTimeoutMs();
    await fs.mkdir(workdir, { recursive: true });
    const frames: ExtractedFrame[] = [];

    try {
      for (let index = 0; index < timestamps.length; index += 1) {
        this.throwIfCancelled(signal);
        const ts = timestamps[index];
        const framePath = join(workdir, `frame-${index + 1}.jpg`);
        try {
          await this.execCommand(
            'ffmpeg',
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-ss',
              String(ts),
              '-i',
              videoUrl,
              '-frames:v',
              '1',
              '-vf',
              'scale=720:-1',
              '-q:v',
              '4',
              '-y',
              framePath,
            ],
            timeoutMs,
            signal
          );
          const buffer = await fs.readFile(framePath);
          if (!buffer.length) {
            continue;
          }
          frames.push({
            index: frames.length + 1,
            timestampSec: Math.max(0, Math.round(ts)),
            timestampLabel: this.toTimeLabel(ts),
            imageDataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
          });
        } catch (error) {
          if (this.isCancelError(error)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'unknown';
          this.logger.warn(`extractFramesAsDataUrls frame skip: ${message}`);
        }
      }
      return frames;
    } finally {
      await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runFrameLevelVisionAnalysis(
    endpoint: string,
    apiKey: string,
    model: string,
    item: MaterialAnalysisItem,
    videoUrl: string,
    signal?: AbortSignal
  ): Promise<VisionResult | null> {
    const frames = await this.extractFramesAsDataUrls(videoUrl, signal);
    if (!frames.length) {
      return null;
    }

    const frameAnalyses: VisionResult['frameAnalyses'] = [];
    const rawParts: string[] = [];
    const sceneParts: string[] = [];

    for (const frame of frames) {
      this.throwIfCancelled(signal);
      const previous = frameAnalyses
        .slice(-2)
        .map(
          (entry) =>
            `[${entry.timestampLabel}] ${entry.summary}${entry.keywords.length ? ` (${entry.keywords.join(', ')})` : ''}`
        )
        .join('\n');
      const framePrompt = [
        '你是短视频关键帧分析助手。只返回 JSON，不要输出 Markdown，不要输出额外说明。',
        '所有字符串字段必须使用简体中文。',
        'Schema: {"summary":"","keywords":[""],"scene":""}',
        '要求：summary 用一句中文概括当前帧核心信息（不超过36字）；keywords 返回3-6个中文短词；scene 为中文场景短语。',
        `视频标题: ${item.title || ''}`,
        `视频描述: ${item.desc || ''}`,
        `当前帧时间: ${frame.timestampLabel}`,
        previous ? `前序关键帧观察（保持时序连贯）:\n${previous}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const data = await this.fetchJsonWithRetry<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: '你是视觉分析助手。必须只输出 JSON，且文本为简体中文。' },
              {
                role: 'user',
                content: [
                  { type: 'text', text: framePrompt },
                  { type: 'image_url', image_url: { url: frame.imageDataUrl } },
                ],
              },
            ],
          }),
        },
        70_000,
        1,
        { signal }
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const summary =
        (typeof parsed.summary === 'string' && parsed.summary.trim()) ||
        (typeof parsed.description === 'string' && parsed.description.trim()) ||
        `关键帧 ${frame.timestampLabel}`;
      const keywords = this.parseStringArray(parsed.keywords).slice(0, 6);
      const scene =
        (typeof parsed.scene === 'string' && parsed.scene.trim()) ||
        (typeof parsed.scenes === 'string' && parsed.scenes.trim()) ||
        '';
      frameAnalyses.push({
        index: frame.index,
        timestampSec: frame.timestampSec,
        timestampLabel: frame.timestampLabel,
        thumbnailUrl: frame.imageDataUrl,
        summary: summary.slice(0, 220),
        keywords,
      });
      if (scene) {
        sceneParts.push(scene.slice(0, 120));
      }
      rawParts.push(
        `[${frame.timestampLabel}] ${this.buildRawModelText(text, data).slice(0, 1800)}`
      );
    }

    const timelineSummary = frameAnalyses
      .slice(0, 6)
      .map((entry) => `[${entry.timestampLabel}] ${entry.summary}`)
      .join(' ');
    const keywords = this.dedupeStrings(
      frameAnalyses.flatMap((entry) => entry.keywords)
    ).slice(0, 10);
    const keyframes = frameAnalyses.map(
      (entry) => `[${entry.timestampLabel}] ${entry.summary}`
    );

    return {
      frameAnalyses,
      modelUsed: model,
      confidence: 0.86,
      mediaUrl: videoUrl,
      mediaType: 'video',
      summary: timelineSummary || this.shortSummary(item.desc || ''),
      keywords,
      scenes: this.dedupeStrings(sceneParts).slice(0, 8),
      keyframes,
      rawText: rawParts.join('\n\n---FRAME---\n').slice(0, 16000),
    };
  }

  private async runVisionAnalysis(
    item: MaterialAnalysisItem,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<VisionResult> {
    const provider = this.resolveVisionProvider();
    if (provider === 'doubao') {
      return this.runVisionAnalysisDoubao(item, signal);
    }
    return this.runVisionAnalysisAliyun(item, apiKey || this.resolveQwenApiKey(), signal);
  }

  private async runVisionAnalysisAliyun(
    item: MaterialAnalysisItem,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<VisionResult> {
    if (!apiKey) {
      return this.buildVisionFallback(item, this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl), 'qwen api key missing');
    }
    const model = process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const contentMediaUrl = this.normalizeHttp(item.contentUrl);
    const coverMediaUrl = this.normalizeHttp(item.coverUrl);
    const candidates: Array<{ mediaUrl: string; mediaType: 'video' | 'image' }> = [];
    if (contentMediaUrl) {
      candidates.push({
        mediaUrl: contentMediaUrl,
        mediaType: this.isVideoUrl(contentMediaUrl) ? 'video' : 'image',
      });
    }
    if (coverMediaUrl && coverMediaUrl !== contentMediaUrl) {
      candidates.push({ mediaUrl: coverMediaUrl, mediaType: 'image' });
    }
    if (!candidates.length) {
      return this.buildVisionFallback(item, '');
    }

    const prompt = [
      '你是短视频视觉分析助手。只返回 JSON，不要输出 Markdown，不要输出额外解释。',
      '所有字符串字段必须使用简体中文。',
      'Schema: {"summary":"","keywords":[""],"scenes":[""],"keyframes":[""],"frameAnalyses":[{"timestampSec":0,"summary":"","keywords":[""]}]}',
      '若媒体是视频，frameAnalyses 返回 4-8 个关键时刻，按时间升序。',
      'keyframes 与 frameAnalyses 必须按索引一一对应、长度一致；keyframes 每项格式建议为 [mm:ss] 该帧一句话描述。',
      'scenes 返回中文场景词，keywords 返回中文关键词。',
      `视频标题: ${item.title || ''}`,
      `视频描述: ${item.desc || ''}`,
    ].join('\n');
    const errors: string[] = [];
    for (const candidate of candidates) {
      this.throwIfCancelled(signal);
      const isVideo = candidate.mediaType === 'video';
      if (isVideo && this.shouldUseFrameExtractor()) {
        try {
          const frameResult = await this.runFrameLevelVisionAnalysis(
            endpoint,
            apiKey,
            model,
            item,
            candidate.mediaUrl,
            signal
          );
          if (frameResult) {
            return {
              ...frameResult,
              modelUsed: `${model}(frame-extractor)`,
              mediaUrl: candidate.mediaUrl,
              mediaType: 'video',
            };
          }
        } catch (error) {
          if (this.isCancelError(error)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'unknown';
          errors.push(`video-frame:${message}`);
          this.logger.warn(`runVisionAnalysis frame extractor fallback: ${message}`);
        }
      }
      try {
        const data = await this.fetchJsonWithRetry<any>(
          endpoint,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              messages: [
                { role: 'system', content: '你是视觉分析助手。必须只输出 JSON，且文本为简体中文。' },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    isVideo
                      ? { type: 'video_url', video_url: { url: candidate.mediaUrl } }
                      : { type: 'image_url', image_url: { url: candidate.mediaUrl } },
                  ],
                },
              ],
            }),
          },
          isVideo ? 90_000 : 60_000,
          isVideo ? 2 : 1,
          { signal }
        );
        const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
        const parsed = this.parseJson(text);
        const keyframes =
          this.parseKeyframes(parsed.keyframes).length > 0
            ? this.parseKeyframes(parsed.keyframes)
            : this.parseKeyframes((parsed as any).frames);
        const frameAnalyses = this.parseFrameAnalyses(
          parsed.frameAnalyses ?? (parsed as any).frame_analyses ?? (parsed as any).frames,
          keyframes,
          typeof parsed.summary === 'string' ? parsed.summary : this.shortSummary(item.desc || '')
        );
        const normalizedKeyframes =
          frameAnalyses.length > 0
            ? frameAnalyses.map((entry) => `[${entry.timestampLabel}] ${entry.summary}`)
            : keyframes;
        return {
          frameAnalyses,
          modelUsed: model,
          confidence: isVideo ? 0.84 : 0.8,
          mediaUrl: candidate.mediaUrl,
          mediaType: candidate.mediaType,
          summary: typeof parsed.summary === 'string' ? parsed.summary : this.shortSummary(item.desc || ''),
          keywords: this.parseStringArray(parsed.keywords),
          scenes: this.parseStringArray(parsed.scenes),
          keyframes: normalizedKeyframes,
          rawText: this.buildRawModelText(text, data),
        };
      } catch (error) {
        if (this.isCancelError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : 'unknown';
        errors.push(`${candidate.mediaType}:${message}`);
        this.logger.warn(`runVisionAnalysis candidate fallback (${candidate.mediaType}): ${message}`);
      }
    }

    return this.buildVisionFallback(item, candidates[0]?.mediaUrl || '', errors.join(' | '));
  }

  private async runVisionAnalysisDoubao(
    item: MaterialAnalysisItem,
    signal?: AbortSignal
  ): Promise<VisionResult> {
    const apiKey = this.resolveDoubaoVlApiKey();
    const model = this.resolveDoubaoVlModel();
    const baseUrl = this.resolveDoubaoVlBaseUrl();
    if (!apiKey || !model || !baseUrl) {
      return this.buildVisionFallback(
        item,
        this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl),
        'doubao vl config missing'
      );
    }
    const preferredMode = this.resolveDoubaoVlApiMode();
    const responsesEndpoint = this.resolveDoubaoVlResponsesUrl();
    const chatEndpoint = this.resolveDoubaoVlChatCompletionsUrl();
    const contentMediaUrl = this.normalizeHttp(item.contentUrl);
    const coverMediaUrl = this.normalizeHttp(item.coverUrl);
    const candidates: Array<{ mediaUrl: string; mediaType: 'video' | 'image' }> = [];
    if (contentMediaUrl) {
      candidates.push({
        mediaUrl: contentMediaUrl,
        mediaType: this.isVideoUrl(contentMediaUrl) ? 'video' : 'image',
      });
    }
    if (coverMediaUrl && coverMediaUrl !== contentMediaUrl) {
      candidates.push({ mediaUrl: coverMediaUrl, mediaType: 'image' });
    }
    if (!candidates.length) {
      return this.buildVisionFallback(item, '');
    }

    const allowVideoUrl = process.env.DOUBAO_VL_ALLOW_VIDEO_URL === 'true';
    const prompt = [
      '你是短视频视觉分析助手。只返回 JSON，不要输出 Markdown，不要输出额外解释。',
      '所有字符串字段必须使用简体中文。',
      'Schema: {"summary":"","keywords":[""],"scenes":[""],"keyframes":[""],"frameAnalyses":[{"timestampSec":0,"summary":"","keywords":[""]}]}',
      '若媒体是视频，frameAnalyses 返回 4-8 个关键时刻，按时间升序。',
      'keyframes 与 frameAnalyses 必须按索引一一对应、长度一致；keyframes 每项格式建议为 [mm:ss] 该帧一句话描述。',
      '若媒体是图片，请保守推断场景演进。',
      `视频标题: ${item.title || ''}`,
      `视频描述: ${item.desc || ''}`,
    ].join('\n');

    const errors: string[] = [];
    for (const candidate of candidates) {
      this.throwIfCancelled(signal);
      if (candidate.mediaType === 'video' && this.shouldUseFrameExtractor()) {
        try {
          const frameResult = await this.runFrameLevelVisionAnalysis(
            chatEndpoint,
            apiKey,
            model,
            item,
            candidate.mediaUrl,
            signal
          );
          if (frameResult) {
            return {
              ...frameResult,
              modelUsed: `${model}(doubao-frame-extractor)`,
              mediaUrl: candidate.mediaUrl,
              mediaType: 'video',
            };
          }
        } catch (error) {
          if (this.isCancelError(error)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'unknown';
          errors.push(`video-frame:${message}`);
          this.logger.warn(`runVisionAnalysisDoubao frame extractor fallback: ${message}`);
        }
      }
      if (candidate.mediaType === 'video' && !allowVideoUrl) {
        errors.push('video:disabled by DOUBAO_VL_ALLOW_VIDEO_URL');
        continue;
      }

      const callModes: Array<'responses' | 'chat'> =
        preferredMode === 'responses' ? ['responses', 'chat'] : ['chat', 'responses'];
      for (const mode of callModes) {
        if (mode === 'responses' && candidate.mediaType === 'video') {
          errors.push('video:responses-mode-skip-direct-video');
          continue;
        }
        try {
          const data =
            mode === 'responses'
              ? await this.fetchJsonWithRetry<any>(
                  responsesEndpoint,
                  {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      input: [
                        {
                          role: 'user',
                          content: [
                            { type: 'input_image', image_url: candidate.mediaUrl },
                            { type: 'input_text', text: prompt },
                          ],
                        },
                      ],
                    }),
                  },
                  60_000,
                  1,
                  { signal }
                )
              : await this.fetchJsonWithRetry<any>(
                  chatEndpoint,
                  {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      temperature: 0.2,
                      messages: [
                        { role: 'system', content: '你是视觉分析助手。必须只输出 JSON，且文本为简体中文。' },
                        {
                          role: 'user',
                          content: [
                            { type: 'text', text: prompt },
                            candidate.mediaType === 'video'
                              ? { type: 'video_url', video_url: { url: candidate.mediaUrl } }
                              : { type: 'image_url', image_url: { url: candidate.mediaUrl } },
                          ],
                        },
                      ],
                    }),
                  },
                  candidate.mediaType === 'video' ? 90_000 : 60_000,
                  candidate.mediaType === 'video' ? 2 : 1,
                  { signal }
                );

          const text =
            (mode === 'responses'
              ? this.extractDoubaoResponsesText(data)
              : this.extractMessageText(data?.choices?.[0]?.message?.content)) ||
            this.extractMessageText(data?.choices?.[0]?.message?.content) ||
            this.extractDoubaoResponsesText(data);
          const parsed = this.parseJson(text || this.safeStringify(data));
          const keyframes =
            this.parseKeyframes(parsed.keyframes).length > 0
              ? this.parseKeyframes(parsed.keyframes)
              : this.parseKeyframes((parsed as any).frames);
          const frameAnalyses = this.parseFrameAnalyses(
            parsed.frameAnalyses ?? (parsed as any).frame_analyses ?? (parsed as any).frames,
            keyframes,
            typeof parsed.summary === 'string' ? parsed.summary : this.shortSummary(item.desc || '')
          );
          const normalizedKeyframes =
            frameAnalyses.length > 0
              ? frameAnalyses.map((entry) => `[${entry.timestampLabel}] ${entry.summary}`)
              : keyframes;

          return {
            frameAnalyses,
            modelUsed:
              mode === 'responses' ? `${model}(doubao-responses)` : `${model}(doubao-chat)`,
            confidence: candidate.mediaType === 'video' ? 0.82 : 0.78,
            mediaUrl: candidate.mediaUrl,
            mediaType: candidate.mediaType,
            summary:
              typeof parsed.summary === 'string'
                ? parsed.summary
                : this.shortSummary(item.desc || ''),
            keywords: this.parseStringArray(parsed.keywords),
            scenes: this.parseStringArray(parsed.scenes),
            keyframes: normalizedKeyframes,
            rawText: this.buildRawModelText(text, data),
          };
        } catch (error) {
          if (this.isCancelError(error)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : 'unknown';
          errors.push(`${candidate.mediaType}:${mode}:${message}`);
          this.logger.warn(
            `runVisionAnalysisDoubao candidate fallback (${candidate.mediaType}/${mode}): ${message}`
          );
        }
      }
    }

    return this.buildVisionFallback(item, candidates[0]?.mediaUrl || '', errors.join(' | '));
  }

  private async runAsrAnalysis(
    item: MaterialAnalysisItem,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<AsrResult> {
    const prepared = await this.prepareAsrAudioInput(item, signal);
    if (!prepared?.mediaSource) {
      return this.buildAsrFallback(item, '');
    }

    const provider = this.resolveAsrProvider();
    try {
      if (provider === 'doubao') {
        const primary = await this.runAsrAnalysisDoubao(item, prepared, signal);
        if (!this.isAsrHeuristicFallback(primary)) {
          return primary;
        }
        if (this.hasAliyunAsrConfig(apiKey)) {
          this.logger.warn(
            'runAsrAnalysis primary=doubao fallback detected, retry provider=aliyun'
          );
          const secondary = await this.runAsrAnalysisAliyun(
            item,
            apiKey || this.resolveQwenApiKey(),
            prepared,
            signal
          );
          if (!this.isAsrHeuristicFallback(secondary)) {
            return secondary;
          }
        }
        return primary;
      }

      const primary = await this.runAsrAnalysisAliyun(
        item,
        apiKey || this.resolveQwenApiKey(),
        prepared,
        signal
      );
      if (!this.isAsrHeuristicFallback(primary)) {
        return primary;
      }
      if (this.hasDoubaoAsrConfig()) {
        this.logger.warn(
          'runAsrAnalysis primary=aliyun fallback detected, retry provider=doubao'
        );
        const secondary = await this.runAsrAnalysisDoubao(item, prepared, signal);
        if (!this.isAsrHeuristicFallback(secondary)) {
          return secondary;
        }
      }
      return primary;
    } finally {
      await this.cleanupPreparedAsrAudio(prepared);
    }
  }

  private async runAsrAnalysisAliyun(
    item: MaterialAnalysisItem,
    apiKey: string,
    prepared: PreparedAsrAudio,
    signal?: AbortSignal
  ): Promise<AsrResult> {
    if (!apiKey) {
      return this.buildAsrFallback(item, prepared.mediaSource, 'qwen api key missing');
    }
    const audioModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const mediaSource = prepared.mediaSource;

    try {
      this.throwIfCancelled(signal);
      const data = await this.fetchJsonWithRetry<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: audioModel,
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    input_audio: {
                      data: prepared.aliyunInputData,
                      format: prepared.format,
                    },
                  },
                  {
                    type: 'text',
                    text:
                      'Return JSON only: {"transcript":"","language":"","emotion":"","segments":[{"startSec":0,"endSec":0,"text":""}]}',
                  },
                ],
              },
            ],
          }),
        },
        120_000,
        2,
        { signal }
      );
      const msg = data?.choices?.[0]?.message;
      const responseText = this.extractMessageText(msg?.content);
      const parsed = this.parseJson(responseText);
      const transcriptCandidate =
        typeof parsed.transcript === 'string' ? parsed.transcript : responseText;
      const transcript = transcriptCandidate.trim();
      const ann = Array.isArray(msg?.annotations) ? msg.annotations[0] || {} : {};
      const segments = this.parseAsrSegments(parsed.segments, transcript, 15);
      return {
        modelUsed: `${audioModel}(audio-file)`,
        confidence: transcript ? 0.85 : 0.62,
        audioSource: mediaSource,
        transcript: transcript || this.shortSummary(item.desc || ''),
        language: typeof ann.language === 'string' ? ann.language : 'unknown',
        emotion: typeof ann.emotion === 'string' ? ann.emotion : 'stable',
        segments,
        rawText: this.buildRawModelText(responseText, data),
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runAsrAnalysis fallback: ${message}`);
      return this.buildAsrFallback(item, mediaSource, message);
    }
  }

  private async runAsrAnalysisDoubao(
    item: MaterialAnalysisItem,
    prepared: PreparedAsrAudio,
    signal?: AbortSignal
  ): Promise<AsrResult> {
    const appId = this.resolveDoubaoAsrAppId();
    const accessToken = this.resolveDoubaoAsrAccessToken();
    const secretToken = this.resolveDoubaoAsrSecretToken();
    const authToken = accessToken || secretToken;
    const resourceId = this.resolveDoubaoAsrResourceId();
    const submitUrl = this.resolveDoubaoAsrSubmitUrl();
    const queryUrl = this.resolveDoubaoAsrQueryUrl();
    const mediaSource = prepared.mediaSource;
    if (!mediaSource) {
      return this.buildAsrFallback(item, '');
    }
    if (!appId || !authToken || !resourceId) {
      return this.buildAsrFallback(item, mediaSource, 'doubao asr config missing');
    }

    const requestId = `materials-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-Api-App-Key': appId,
      'X-Api-Access-Key': authToken,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    };
    // Some tenants still require Secret Token style bearer auth.
    if (secretToken) {
      headers.Authorization = `Bearer; ${secretToken}`;
    }
    const audioPayload: Record<string, unknown> = {
      format: prepared.format || this.detectAudioFormat(mediaSource),
    };
    if (prepared.doubaoAudioData) {
      audioPayload.data = prepared.doubaoAudioData;
    } else {
      audioPayload.url = mediaSource;
    }

    const submitPayload = {
      user: { uid: item.authorUserId || item.externalId || 'materials-ai' },
      audio: audioPayload,
      request: {
        model_name: process.env.DOUBAO_ASR_MODEL_NAME || 'bigmodel',
        show_utterances: true,
        enable_itn: true,
        enable_punc: true,
      },
    };

    try {
      this.throwIfCancelled(signal);
      const submitResponse = await this.fetchWithTimeout(
        submitUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(submitPayload),
        },
        60_000,
        signal
      );
      if (!submitResponse.ok) {
        const bodyText = await submitResponse.text();
        return this.buildAsrFallback(
          item,
          mediaSource,
          `doubao submit failed: ${submitResponse.status} ${bodyText}`
        );
      }
      const submitStatusCode = submitResponse.headers.get('x-api-status-code') || '';
      const submitStatusMessage = submitResponse.headers.get('x-api-message') || '';
      if (
        submitStatusCode &&
        submitStatusCode !== '20000000' &&
        submitStatusCode !== '20000001' &&
        submitStatusCode !== '20000002'
      ) {
        return this.buildAsrFallback(
          item,
          mediaSource,
          `doubao submit status: ${submitStatusCode} ${submitStatusMessage}`
        );
      }

      const pollIntervalMs = this.resolveDoubaoAsrPollIntervalMs();
      const maxPolls = this.resolveDoubaoAsrMaxPolls();
      let lastBody: any = null;
      let lastStatusCode = '';

      for (let i = 0; i < maxPolls; i += 1) {
        this.throwIfCancelled(signal);
        const queryResponse = await this.fetchWithTimeout(
          queryUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
          },
          60_000,
          signal
        );
        const statusCode = queryResponse.headers.get('x-api-status-code') || '';
        const statusMessage = queryResponse.headers.get('x-api-message') || '';
        const text = await queryResponse.text();
        let body: any = {};
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { rawText: text };
          }
        }
        lastBody = body;
        lastStatusCode = statusCode;

        if (!queryResponse.ok) {
          return this.buildAsrFallback(
            item,
            mediaSource,
            `doubao query failed: ${queryResponse.status} ${statusMessage || text}`
          );
        }

        if (statusCode === '20000000') {
          const resultNode = Array.isArray(body?.result) ? body.result[0] || {} : body?.result || body;
          const utterances = Array.isArray(resultNode?.utterances)
            ? resultNode.utterances
            : Array.isArray(body?.utterances)
            ? body.utterances
            : [];
          const transcript =
            (typeof resultNode?.text === 'string' && resultNode.text) ||
            (typeof body?.text === 'string' && body.text) ||
            utterances
              .map((u: any) => (typeof u?.text === 'string' ? u.text : ''))
              .filter(Boolean)
              .join('\n');

          const segments = this.parseAsrSegments(
            utterances.map((u: any) => ({
              startSec:
                typeof u?.start_time === 'number'
                  ? Number((u.start_time / 1000).toFixed(3))
                  : u?.start_time,
              endSec:
                typeof u?.end_time === 'number'
                  ? Number((u.end_time / 1000).toFixed(3))
                  : u?.end_time,
              text: u?.text,
            })),
            transcript || '',
            15
          );

          return {
            modelUsed: `doubao-asr(${submitPayload.request.model_name})`,
            confidence: transcript ? 0.82 : 0.6,
            audioSource: mediaSource,
            transcript: transcript || this.shortSummary(item.desc || ''),
            language: (typeof body?.language === 'string' && body.language) || 'unknown',
            emotion: 'stable',
            segments: segments.length ? segments : this.parseAsrSegments([], transcript || '', 15),
            rawText: this.safeStringify(body).slice(0, 4000),
          };
        }

        if (statusCode && statusCode !== '20000001' && statusCode !== '20000002') {
          return this.buildAsrFallback(
            item,
            mediaSource,
            `doubao query status: ${statusCode} ${statusMessage}`
          );
        }
        await this.delayWithCancel(pollIntervalMs, signal);
      }

      return this.buildAsrFallback(
        item,
        mediaSource,
        `doubao query timeout: ${lastStatusCode || 'unknown'} ${this.safeStringify(lastBody).slice(0, 200)}`
      );
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runAsrAnalysisDoubao fallback: ${message}`);
      return this.buildAsrFallback(item, mediaSource, message);
    }
  }

  private async runSemanticAnalysis(
    item: MaterialAnalysisItem,
    vision: VisionResult,
    asr: AsrResult,
    provider: MaterialsLlmProvider,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<SemanticResult> {
    const model = this.resolveSemanticModel(provider);
    const endpoint = this.resolveLlmChatEndpoint(provider);
    const fallbackPrompt = [
      'You are a short-video strategist. Return JSON only.',
      'Combine visual evidence and ASR transcript to provide a 360 content understanding.',
      'Schema: {"summary":"","highlights":[""],"keywords":[""],"insights":[""],"tone":"","fullSummary360":"","profile360":{"speakingFormat":"","narratorRole":"","productionApproach":[""],"expressionStyle":[""],"persuasionPath":[""],"authoritySignals":[""],"complianceSignals":[""],"audienceFit":[""],"risks":[""],"reusableAngles":[""]}}',
      'title: {{title}}',
      'desc: {{desc}}',
      'visual summary: {{visual_summary}}',
      'asr transcript: {{asr_transcript}}',
      'visual keyframes: {{visual_keyframes}}',
      'visual frame analyses: {{visual_frame_analyses}}',
    ].join('\n');
    const promptTemplate = await this.loadPromptTemplate(
      'semantic-360.prompt.txt',
      fallbackPrompt
    );
    const prompt = this.renderPromptTemplate(promptTemplate, {
      title: item.title || '',
      desc: item.desc || '',
      visual_summary: vision.summary || '',
      asr_transcript: asr.transcript || '',
      visual_keyframes: vision.keyframes.join(' | '),
      visual_frame_analyses: this.safeStringify(vision.frameAnalyses.slice(0, 8)),
    });

    try {
      const data = await this.fetchJson<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: 'JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        },
        60_000,
        { signal }
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const parsedProfile = this.parseProfile360(parsed.profile360);
      const fallbackProfile = this.buildFallbackProfile360(item, vision, asr);
      const profile360: Profile360 = {
        speakingFormat:
          parsedProfile.speakingFormat !== 'unknown'
            ? parsedProfile.speakingFormat
            : fallbackProfile.speakingFormat,
        narratorRole:
          parsedProfile.narratorRole !== 'unknown'
            ? parsedProfile.narratorRole
            : fallbackProfile.narratorRole,
        productionApproach: parsedProfile.productionApproach.length
          ? parsedProfile.productionApproach
          : fallbackProfile.productionApproach,
        expressionStyle: parsedProfile.expressionStyle.length
          ? parsedProfile.expressionStyle
          : fallbackProfile.expressionStyle,
        persuasionPath: parsedProfile.persuasionPath.length
          ? parsedProfile.persuasionPath
          : fallbackProfile.persuasionPath,
        authoritySignals: parsedProfile.authoritySignals.length
          ? parsedProfile.authoritySignals
          : fallbackProfile.authoritySignals,
        complianceSignals: parsedProfile.complianceSignals.length
          ? parsedProfile.complianceSignals
          : fallbackProfile.complianceSignals,
        audienceFit: parsedProfile.audienceFit.length
          ? parsedProfile.audienceFit
          : fallbackProfile.audienceFit,
        risks: parsedProfile.risks.length ? parsedProfile.risks : fallbackProfile.risks,
        reusableAngles: parsedProfile.reusableAngles.length
          ? parsedProfile.reusableAngles
          : fallbackProfile.reusableAngles,
      };
      return {
        modelUsed: provider === 'doubao' ? `${model}(doubao-llm)` : model,
        confidence: 0.83,
        summary: typeof parsed.summary === 'string' ? parsed.summary : this.shortSummary(item.desc || ''),
        highlights: this.parseStringArray(parsed.highlights).slice(0, 8),
        keywords: this.parseStringArray(parsed.keywords).slice(0, 10),
        insights: this.parseStringArray(parsed.insights).slice(0, 8),
        tone: typeof parsed.tone === 'string' ? parsed.tone : 'neutral',
        fullSummary360:
          typeof parsed.fullSummary360 === 'string'
            ? parsed.fullSummary360.slice(0, 1200)
            : this.buildFallbackFullSummary360(item, profile360),
        profile360,
        rawText: text.slice(0, 4000),
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runSemanticAnalysis fallback: ${message}`);
      return this.buildSemanticFallback(item, vision, asr, message);
    }
  }

  private async runContentUnderstandingPipeline(
    item: MaterialAnalysisItem,
    asr: AsrResult,
    semantic: SemanticResult,
    provider: MaterialsLlmProvider,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ContentUnderstandingLayer> {
    this.throwIfCancelled(signal);
    const segments = this.parseAsrSegments(asr.segments, asr.transcript, 15);
    if (!segments.length) {
      return this.buildFallbackContentUnderstanding(item, asr);
    }
    const model = this.resolveContentModel(provider);
    const endpoint = this.resolveLlmChatEndpoint(provider);

    const outline = await this.runContentOutlineStep(
      item,
      segments,
      model,
      endpoint,
      apiKey,
      signal
    );
    const timeline = await this.runContentTimelineStep(
      item,
      segments,
      outline.items,
      model,
      endpoint,
      apiKey,
      signal
    );
    const scoring = await this.runContentScoringStep(
      item,
      timeline.segments,
      semantic,
      model,
      endpoint,
      apiKey,
      signal
    );

    return {
      promptVersion: this.resolveContentPromptVersion(),
      outline,
      timeline,
      scoring,
    };
  }

  private async runContentOutlineStep(
    item: MaterialAnalysisItem,
    segments: Array<{ startSec: number; endSec: number; text: string }>,
    model: string,
    endpoint: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ContentUnderstandingLayer['outline']> {
    this.throwIfCancelled(signal);
    const transcriptInput = this.buildTimestampTranscript(segments);
    const fallbackItems = this.buildRuleOutlineFromTranscript(item, segments);
    const fallbackPrompt = [
      'You are a short video content strategist.',
      'Return JSON only.',
      'Schema: {"items":[{"id":"","title":"","summary":"","keywords":[""]}]}',
      'Rules:',
      '1) 3-8 items.',
      '2) Keep titles concise.',
      '3) keywords should be practical and reusable.',
      'title: {{title}}',
      'desc: {{desc}}',
      'asr_segments:\n{{asr_segments}}',
    ].join('\n');
    const promptTemplate = await this.loadPromptTemplate(
      'content-outline.prompt.txt',
      fallbackPrompt
    );
    const prompt = this.renderPromptTemplate(promptTemplate, {
      title: item.title || '',
      desc: item.desc || '',
      asr_segments: transcriptInput,
    });

    try {
      const data = await this.fetchJsonWithRetry<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: 'JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        },
        60_000,
        1,
        { signal }
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const items = this.parseOutlineItems(parsed.items ?? parsed.outlines ?? parsed);
      if (!items.length) {
        return {
          source: 'rule',
          items: fallbackItems,
          rawText: this.buildRawModelText(text, data),
        };
      }
      return {
        source: 'qwen',
        items,
        rawText: this.buildRawModelText(text, data),
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      return {
        source: 'rule',
        items: fallbackItems,
        rawText: `fallback: ${message}`,
      };
    }
  }

  private async runContentTimelineStep(
    item: MaterialAnalysisItem,
    asrSegments: Array<{ startSec: number; endSec: number; text: string }>,
    outlineItems: ContentOutlineItem[],
    model: string,
    endpoint: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ContentUnderstandingLayer['timeline']> {
    this.throwIfCancelled(signal);
    const fallbackSegments = this.buildRuleTimeline(outlineItems, asrSegments);
    const fallbackPrompt = [
      'You are a timeline alignment engine.',
      'Return JSON only.',
      'Schema: {"segments":[{"id":"","outlineId":"","outlineTitle":"","startSec":0,"endSec":0,"text":"","keywords":[""]}]}',
      'Align each transcript segment to one outline topic.',
      'title: {{title}}',
      'desc: {{desc}}',
      'outline_items: {{outline_items}}',
      'asr_segments: {{asr_segments}}',
    ].join('\n');
    const promptTemplate = await this.loadPromptTemplate(
      'content-timeline.prompt.txt',
      fallbackPrompt
    );
    const prompt = this.renderPromptTemplate(promptTemplate, {
      title: item.title || '',
      desc: item.desc || '',
      outline_items: this.safeStringify(outlineItems),
      asr_segments: this.safeStringify(asrSegments.slice(0, 120)),
    });

    try {
      const data = await this.fetchJsonWithRetry<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: 'JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        },
        60_000,
        1,
        { signal }
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const parsedSegments = this.parseTimelineSegments(
        parsed.segments ?? parsed.timeline ?? parsed,
        outlineItems,
        asrSegments
      );
      if (!parsedSegments.length) {
        return {
          source: 'rule',
          segments: fallbackSegments,
          rawText: this.buildRawModelText(text, data),
        };
      }
      return {
        source: 'qwen',
        segments: parsedSegments,
        rawText: this.buildRawModelText(text, data),
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      return {
        source: 'rule',
        segments: fallbackSegments,
        rawText: `fallback: ${message}`,
      };
    }
  }

  private async runContentScoringStep(
    item: MaterialAnalysisItem,
    timelineSegments: ContentTimelineSegment[],
    semantic: SemanticResult,
    model: string,
    endpoint: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<ContentUnderstandingLayer['scoring']> {
    this.throwIfCancelled(signal);
    const fallback = this.buildRuleScoring(item, timelineSegments);
    const fallbackPrompt = [
      'You are a viral clip scoring engine.',
      'Return JSON only.',
      'Schema: {"segments":[{"id":"","score":0,"reason":"","evidence":[""]}]}',
      'score must be 0-100.',
      'semantic_summary: {{semantic_summary}}',
      'semantic_highlights: {{semantic_highlights}}',
      'timeline_segments: {{timeline_segments}}',
    ].join('\n');
    const promptTemplate = await this.loadPromptTemplate(
      'content-scoring.prompt.txt',
      fallbackPrompt
    );
    const prompt = this.renderPromptTemplate(promptTemplate, {
      semantic_summary: semantic.summary || '',
      semantic_highlights: this.safeStringify(semantic.highlights),
      timeline_segments: this.safeStringify(timelineSegments.slice(0, 120)),
    });

    try {
      const data = await this.fetchJsonWithRetry<any>(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.1,
            messages: [
              { role: 'system', content: 'JSON only.' },
              { role: 'user', content: prompt },
            ],
          }),
        },
        60_000,
        1,
        { signal }
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const scoreItems = this.parseScoreItems(parsed.segments ?? parsed.scores ?? parsed);
      const scoredSegments = timelineSegments.map((segment) => {
        const hit = scoreItems.find((entry) => entry.id === segment.id) || null;
        const score = this.clamp(Math.round(hit?.score ?? 0), 0, 100);
        return {
          ...segment,
          score,
          reason: (hit?.reason || segment.outlineTitle || 'Score by timeline context').slice(0, 180),
          evidence: (hit?.evidence || []).slice(0, 5),
          isHighEnergy: score >= 75,
        };
      });
      if (!scoredSegments.length || scoredSegments.every((segment) => segment.score === 0)) {
        return {
          ...fallback,
          rawText: this.buildRawModelText(text, data),
        };
      }
      const topSegments = [...scoredSegments]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      const averageScore = Math.round(
        scoredSegments.reduce((sum, segment) => sum + segment.score, 0) /
          Math.max(scoredSegments.length, 1)
      );
      return {
        source: 'qwen',
        segments: scoredSegments,
        topSegments,
        averageScore,
        rawText: this.buildRawModelText(text, data),
      };
    } catch (error) {
      if (this.isCancelError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown';
      return {
        ...fallback,
        rawText: `fallback: ${message}`,
      };
    }
  }

  private buildFallbackContentUnderstanding(
    item: MaterialAnalysisItem,
    asr: AsrResult
  ): ContentUnderstandingLayer {
    const asrSegments = this.parseAsrSegments(asr.segments, asr.transcript, 15);
    const outlineItems = this.buildRuleOutlineFromTranscript(item, asrSegments);
    const timelineSegments = this.buildRuleTimeline(outlineItems, asrSegments);
    const scoring = this.buildRuleScoring(item, timelineSegments);
    return {
      promptVersion: this.resolveContentPromptVersion(),
      outline: {
        source: 'rule',
        items: outlineItems,
        rawText: asr.rawText || '',
      },
      timeline: {
        source: 'rule',
        segments: timelineSegments,
        rawText: asr.rawText || '',
      },
      scoring,
    };
  }

  private buildVisionFallback(item: MaterialAnalysisItem, mediaUrl: string, error?: string): VisionResult {
    const summary = this.shortSummary(item.desc || '');
    return {
      frameAnalyses: summary
        ? [
            {
              index: 1,
              timestampSec: 0,
              timestampLabel: this.toTimeLabel(0),
              summary,
              keywords: this.extractKeywords(`${item.title || ''} ${item.desc || ''}`).slice(0, 4),
            },
          ]
        : [],
      modelUsed: 'local-heuristic',
      confidence: 0.56,
      mediaUrl,
      mediaType: !mediaUrl ? 'unknown' : this.isVideoUrl(mediaUrl) ? 'video' : 'image',
      summary,
      keywords: this.extractKeywords(`${item.title || ''} ${item.desc || ''}`),
      scenes: [],
      keyframes: [],
      rawText: error ? `fallback: ${error}` : '',
    };
  }

  private buildAsrFallback(item: MaterialAnalysisItem, audioSource: string, error?: string): AsrResult {
    const transcript = this.shortSummary(item.desc || '');
    return {
      modelUsed: 'local-heuristic',
      confidence: 0.55,
      audioSource,
      transcript,
      language: 'unknown',
      emotion: 'stable',
      segments: this.parseAsrSegments([], transcript, 15),
      rawText: error ? `fallback: ${error}` : '',
    };
  }

  private buildSemanticFallback(
    item: MaterialAnalysisItem,
    vision: VisionResult,
    asr: AsrResult,
    error?: string
  ): SemanticResult {
    const profile360 = this.buildFallbackProfile360(item, vision, asr);
    return {
      modelUsed: 'local-heuristic',
      confidence: 0.58,
      summary: this.shortSummary(item.desc || ''),
      highlights: [],
      keywords: this.extractKeywords(`${item.title || ''} ${item.desc || ''}`),
      insights: [],
      tone: 'neutral',
      fullSummary360: this.buildFallbackFullSummary360(item, profile360),
      profile360,
      rawText: error ? `fallback: ${error}` : '',
    };
  }

  private buildFallbackProfile360(
    item: MaterialAnalysisItem,
    vision: VisionResult,
    asr: AsrResult
  ): Profile360 {
    const desc = `${item.title || ''} ${item.desc || ''}`.toLowerCase();
    const isMedical =
      /medical|clinic|aesthetic|cosmetic|doctor|hospital/.test(desc) ||
      /clinic|doctor|hospital/.test((item.authorName || '').toLowerCase());
    const hasTranscript = (asr.transcript || '').trim().length > 20;
    return {
      speakingFormat: hasTranscript
        ? 'voice-over / explanation'
        : vision.mediaType === 'video'
        ? 'subtitle-driven or weak voice-over'
        : 'image/post style',
      narratorRole: isMedical ? 'medical/professional account' : 'creator/brand account',
      productionApproach: vision.scenes.slice(0, 3),
      expressionStyle: [
        'information-dense',
        hasTranscript ? 'spoken-language delivery' : 'visual + subtitle delivery',
      ],
      persuasionPath: isMedical
        ? ['professional identity', 'case/effect explanation', 'clear CTA']
        : ['pain-point hook', 'value explanation', 'clear CTA'],
      authoritySignals: isMedical
        ? ['professional identity', 'institution credentials', 'terminology explanation']
        : ['product features', 'user feedback'],
      complianceSignals: isMedical
        ? ['avoid medical efficacy guarantee', 'avoid absolute terms', 'add risk disclaimer']
        : ['avoid exaggerated claims', 'emphasize individual differences'],
      audienceFit: isMedical ? ['aesthetic intent users', 'rational result seekers'] : ['broad consumer users'],
      risks: isMedical
        ? ['medical compliance risk', 'overpromise risk']
        : ['homogeneous content risk'],
      reusableAngles: [
        'deliver core conclusion in first 3 seconds',
        'state target users first, then evidence and limitations',
        'end with explicit consult/DM CTA',
      ],
    };
  }

  private buildFallbackFullSummary360(item: MaterialAnalysisItem, profile360: Profile360) {
    const title = item.title || 'this material';
    return [
      `Material "${title}" is primarily ${profile360.speakingFormat}, and narrator role is ${profile360.narratorRole}.`,
      `Style: ${profile360.expressionStyle.join(', ') || 'informational'}; persuasion path: ${profile360.persuasionPath.join(' -> ') || 'value progression'}.`,
      `Authority signals: ${profile360.authoritySignals.join(', ') || 'none'}.`,
      `Compliance guidance: ${profile360.complianceSignals.join(', ') || 'keep claims evidence-based and conservative'}.`,
    ].join('\n');
  }

  private parseKeyframes(value: unknown) {
    if (typeof value === 'string') {
      return value
        .split(/[\r\n;，]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          const r = entry as Record<string, unknown>;
          const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
          const desc = typeof r.description === 'string' ? r.description : '';
          const point = typeof r.sellingPoint === 'string' ? r.sellingPoint : '';
          return [ts, desc, point].filter(Boolean).join(' | ').trim();
        }
        return '';
      })
      .filter(Boolean);
  }

  private parseFrameAnalyses(
    value: unknown,
    fallbackKeyframes: string[],
    fallbackSummary: string
  ): Array<{
    index: number;
    timestampSec: number;
    timestampLabel: string;
    thumbnailUrl?: string;
    summary: string;
    keywords: string[];
  }> {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as any).items)
      ? (value as any).items
      : [];
    const parsed = list
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const row = entry as Record<string, unknown>;
        const summary =
          typeof row.summary === 'string'
            ? row.summary.trim()
            : typeof row.description === 'string'
            ? row.description.trim()
            : typeof row.note === 'string'
            ? row.note.trim()
            : '';
        const tsRaw =
          row.timestampSec ??
          row.timestamp ??
          row.timeSec ??
          row.time ??
          row.second ??
          row.positionSec;
        const timestampSec = this.toSeconds(tsRaw) ?? index * 5;
        const thumbnailUrlRaw =
          row.thumbnailUrl ??
          row.thumbnail ??
          row.imageUrl ??
          row.image ??
          row.frameUrl;
        const thumbnailUrl =
          typeof thumbnailUrlRaw === 'string' && thumbnailUrlRaw.trim()
            ? thumbnailUrlRaw.trim()
            : undefined;
        const keywords = this.parseStringArray(row.keywords).slice(0, 6);
        if (!summary) {
          return null;
        }
        return {
          index: index + 1,
          timestampSec: this.clamp(Math.round(timestampSec), 0, 36000),
          timestampLabel: this.toTimeLabel(timestampSec),
          thumbnailUrl,
          summary: summary.slice(0, 200),
          keywords,
        };
      })
      .filter(
        (
          entry
        ): entry is {
          index: number;
          timestampSec: number;
          timestampLabel: string;
          thumbnailUrl?: string;
          summary: string;
          keywords: string[];
        } => Boolean(entry)
      )
      .sort((a, b) => a.timestampSec - b.timestampSec)
      .slice(0, 12);

    if (parsed.length) {
      return parsed.map((entry, index) => ({
        ...entry,
        index: index + 1,
      }));
    }

    if (fallbackKeyframes.length) {
      return fallbackKeyframes.slice(0, 8).map((entry, index) => {
        const ts = this.extractFirstTimestampSec(entry) ?? index * 5;
        const summary = entry.replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/g, '').trim();
        return {
          index: index + 1,
          timestampSec: this.clamp(Math.round(ts), 0, 36000),
          timestampLabel: this.toTimeLabel(ts),
          summary: (summary || fallbackSummary || 'key frame').slice(0, 200),
          keywords: this.extractKeywords(summary || fallbackSummary).slice(0, 4),
        };
      });
    }

    if (!fallbackSummary) {
      return [];
    }
    return [
      {
        index: 1,
        timestampSec: 0,
        timestampLabel: this.toTimeLabel(0),
        summary: fallbackSummary.slice(0, 200),
        keywords: this.extractKeywords(fallbackSummary).slice(0, 4),
      },
    ];
  }

  private extractFirstTimestampSec(text: string): number | null {
    const match = String(text || '').match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (!match) return null;
    return this.toSeconds(match[1]);
  }

  private parseProfile360(value: unknown): Profile360 {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      speakingFormat:
        typeof raw.speakingFormat === 'string' && raw.speakingFormat.trim()
          ? raw.speakingFormat.trim()
          : 'unknown',
      narratorRole:
        typeof raw.narratorRole === 'string' && raw.narratorRole.trim()
          ? raw.narratorRole.trim()
          : 'unknown',
      productionApproach: this.parseStringArray(raw.productionApproach).slice(0, 8),
      expressionStyle: this.parseStringArray(raw.expressionStyle).slice(0, 8),
      persuasionPath: this.parseStringArray(raw.persuasionPath).slice(0, 8),
      authoritySignals: this.parseStringArray(raw.authoritySignals).slice(0, 8),
      complianceSignals: this.parseStringArray(raw.complianceSignals).slice(0, 8),
      audienceFit: this.parseStringArray(raw.audienceFit).slice(0, 8),
      risks: this.parseStringArray(raw.risks).slice(0, 8),
      reusableAngles: this.parseStringArray(raw.reusableAngles).slice(0, 8),
    };
  }

  private resolveContentPromptVersion() {
    return process.env.MATERIALS_CONTENT_PROMPT_VERSION || 'autoclip-migrated-v2';
  }

  private async loadPromptTemplate(name: string, fallback: string): Promise<string> {
    const cached = this.promptTemplateCache.get(name);
    if (cached) {
      return cached;
    }

    const filePath = join(this.promptDir, name);
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
      if (normalized) {
        this.promptTemplateCache.set(name, normalized);
        return normalized;
      }
    } catch (error) {
      if (!this.promptTemplateWarningSet.has(name)) {
        this.promptTemplateWarningSet.add(name);
        const message = error instanceof Error ? error.message : 'unknown';
        this.logger.warn(
          `Prompt template not found, fallback inline: name=${name} dir=${this.promptDir} reason=${message}`
        );
      }
    }

    this.promptTemplateCache.set(name, fallback);
    return fallback;
  }

  private renderPromptTemplate(template: string, params: Record<string, string>) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
      const value = params[key];
      return typeof value === 'string' ? value : '';
    });
  }

  private buildTimestampTranscript(segments: Array<{ startSec: number; endSec: number; text: string }>) {
    return segments
      .slice(0, 160)
      .map(
        (segment) =>
          `[${this.formatTimeSpan(segment.startSec, segment.endSec)}] ${String(segment.text || '')
            .replace(/\s+/g, ' ')
            .trim()}`
      )
      .filter(Boolean)
      .join('\n');
  }

  private buildRuleOutlineFromTranscript(
    item: MaterialAnalysisItem,
    segments: Array<{ startSec: number; endSec: number; text: string }>
  ): ContentOutlineItem[] {
    const mergedText = segments.map((segment) => segment.text).join(' ').trim();
    const title = String(item.title || '').trim();
    const desc = String(item.desc || '').trim();
    const pool = `${title} ${desc} ${mergedText}`.trim();
    const keywords = this.extractKeywords(pool);
    const defaults = [
      { id: 'outline-1', title: 'Opening Hook' },
      { id: 'outline-2', title: 'Core Value' },
      { id: 'outline-3', title: 'Action Close' },
    ];
    const bucketSize = Math.max(1, Math.ceil(segments.length / defaults.length));
    return defaults.map((entry, index) => {
      const chunk = segments
        .slice(index * bucketSize, (index + 1) * bucketSize)
        .map((segment) => segment.text)
        .join(' ')
        .trim();
      return {
        id: entry.id,
        title: entry.title,
        summary: this.shortSummary(chunk || pool),
        keywords: keywords.slice(index * 3, index * 3 + 3),
      };
    });
  }

  private buildRuleTimeline(
    outlineItems: ContentOutlineItem[],
    asrSegments: Array<{ startSec: number; endSec: number; text: string }>
  ): ContentTimelineSegment[] {
    const outlines = outlineItems.length
      ? outlineItems
      : [
          { id: 'outline-1', title: 'Content', summary: '', keywords: [] as string[] },
        ];
    return asrSegments.map((segment, index) => {
      const outlineIndex = Math.floor((index * outlines.length) / Math.max(asrSegments.length, 1));
      const outline = outlines[Math.min(outlineIndex, outlines.length - 1)];
      return {
        id: `timeline-${index + 1}`,
        outlineId: outline.id,
        outlineTitle: outline.title,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
        keywords: this.extractKeywords(segment.text).slice(0, 4),
      };
    });
  }

  private buildRuleScoring(
    item: MaterialAnalysisItem,
    timelineSegments: ContentTimelineSegment[]
  ): ContentUnderstandingLayer['scoring'] {
    const likes = this.safeNum(item.likedCount);
    const comments = this.safeNum(item.commentCount);
    const shares = this.safeNum(item.shareCount);
    const collects = this.safeNum(item.collectedCount);
    const interactions = likes + comments * 1.2 + shares * 1.5 + collects * 1.4;
    const engagementBoost = this.clamp(Math.round(Math.log10(Math.max(interactions, 10)) * 6), 0, 18);
    const segments: ContentScoreSegment[] = timelineSegments.map((segment) => {
      const text = String(segment.text || '').toLowerCase();
      const hookHits = this.includesAny(text, HOOK_KEYWORDS).length;
      const ctaHits = this.includesAny(text, CTA_KEYWORDS).length;
      const emotionHits = this.includesAny(text, EMOTION_KEYWORDS).length;
      const densityBoost = this.clamp(Math.round(text.length / 18), 0, 16);
      const score = this.clamp(
        42 + hookHits * 12 + ctaHits * 10 + emotionHits * 8 + densityBoost + engagementBoost,
        0,
        100
      );
      const reasonParts = [
        hookHits ? 'hook signal detected' : '',
        ctaHits ? 'CTA expression found' : '',
        emotionHits ? 'emotion peak found' : '',
        !hookHits && !ctaHits && !emotionHits ? 'normal informational segment' : '',
      ].filter(Boolean);
      return {
        ...segment,
        score,
        reason: reasonParts.join('; ').slice(0, 180) || segment.outlineTitle,
        evidence: this.extractKeywords(segment.text).slice(0, 5),
        isHighEnergy: score >= 75,
      };
    });
    const topSegments = [...segments].sort((a, b) => b.score - a.score).slice(0, 5);
    const averageScore = Math.round(
      segments.reduce((sum, segment) => sum + segment.score, 0) / Math.max(segments.length, 1)
    );
    return {
      source: 'rule',
      segments,
      topSegments,
      averageScore,
      rawText: '',
    };
  }

  private parseOutlineItems(value: unknown): ContentOutlineItem[] {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { items?: unknown[] }).items)
      ? (value as { items: unknown[] }).items
      : [];
    return list
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null;
        const row = entry as Record<string, unknown>;
        const id =
          typeof row.id === 'string' && row.id.trim()
            ? row.id.trim()
            : `outline-${index + 1}`;
        const title =
          typeof row.title === 'string'
            ? row.title.trim()
            : typeof row.name === 'string'
            ? row.name.trim()
            : '';
        if (!title) return null;
        const summary =
          typeof row.summary === 'string'
            ? row.summary.trim()
            : typeof row.description === 'string'
            ? row.description.trim()
            : '';
        return {
          id,
          title: title.slice(0, 80),
          summary: this.shortSummary(summary),
          keywords: this.parseStringArray(row.keywords).slice(0, 6),
        } as ContentOutlineItem;
      })
      .filter((entry): entry is ContentOutlineItem => Boolean(entry));
  }

  private parseTimelineSegments(
    value: unknown,
    outlineItems: ContentOutlineItem[],
    asrSegments: Array<{ startSec: number; endSec: number; text: string }>
  ): ContentTimelineSegment[] {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { segments?: unknown[] }).segments)
      ? (value as { segments: unknown[] }).segments
      : [];
    const parsed = list
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null;
        const row = entry as Record<string, unknown>;
        const fallbackAsr = asrSegments[Math.min(index, Math.max(0, asrSegments.length - 1))];
        const start = this.toSeconds(row.startSec ?? row.start ?? row.start_time) ?? fallbackAsr?.startSec ?? 0;
        const end = this.toSeconds(row.endSec ?? row.end ?? row.end_time) ?? fallbackAsr?.endSec ?? start + 1;
        if (!(end > start)) return null;
        const outlineIdRaw =
          typeof row.outlineId === 'string'
            ? row.outlineId
            : typeof row.topicId === 'string'
            ? row.topicId
            : '';
        const outlineMatch =
          outlineItems.find((item) => item.id === outlineIdRaw) ||
          outlineItems.find((item) => item.title === row.outlineTitle || item.title === row.topicTitle) ||
          outlineItems[Math.min(index, Math.max(0, outlineItems.length - 1))];
        const text =
          typeof row.text === 'string'
            ? row.text
            : typeof row.content === 'string'
            ? row.content
            : fallbackAsr?.text || '';
        return {
          id:
            typeof row.id === 'string' && row.id.trim()
              ? row.id.trim()
              : `timeline-${index + 1}`,
          outlineId: outlineMatch?.id || 'outline-1',
          outlineTitle: outlineMatch?.title || 'Content',
          startSec: this.clamp(Math.round(start), 0, 36000),
          endSec: this.clamp(Math.max(Math.round(end), Math.round(start) + 1), 1, 36000),
          text: String(text || '').trim().slice(0, 500),
          keywords: this.parseStringArray(row.keywords).slice(0, 5),
        } as ContentTimelineSegment;
      })
      .filter((entry): entry is ContentTimelineSegment => Boolean(entry && entry.text));
    if (parsed.length) {
      return parsed.sort((a, b) => a.startSec - b.startSec);
    }
    return this.buildRuleTimeline(outlineItems, asrSegments);
  }

  private parseScoreItems(value: unknown) {
    const list = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { segments?: unknown[] }).segments)
      ? (value as { segments: unknown[] }).segments
      : [];
    return list
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const row = entry as Record<string, unknown>;
        const id =
          typeof row.id === 'string' && row.id.trim()
            ? row.id.trim()
            : '';
        if (!id) return null;
        const scoreRaw = Number(row.score ?? row.finalScore ?? row.final_score);
        const score = Number.isFinite(scoreRaw) ? scoreRaw : 0;
        const reason =
          typeof row.reason === 'string'
            ? row.reason
            : typeof row.recommendReason === 'string'
            ? row.recommendReason
            : '';
        return {
          id,
          score,
          reason: reason.trim(),
          evidence: this.parseStringArray(row.evidence || row.signals).slice(0, 5),
        };
      })
      .filter(
        (entry): entry is { id: string; score: number; reason: string; evidence: string[] } =>
          Boolean(entry)
      );
  }

  private parseAsrSegments(
    value: unknown,
    transcriptFallback: string,
    defaultDurationSec: number
  ): Array<{ startSec: number; endSec: number; text: string }> {
    const fromObjects = Array.isArray(value)
      ? value
          .map((entry, index) => {
            if (typeof entry === 'string') {
              const line = entry.trim();
              if (!line) return null;
              const timeHit = line.match(
                /^(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:-|~|to|->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?)\s*(.*)$/i
              );
              if (timeHit) {
                const start = this.toSeconds(timeHit[1]);
                const end = this.toSeconds(timeHit[2]);
                if (start !== null && end !== null && end > start) {
                  return {
                    startSec: start,
                    endSec: end,
                    text: String(timeHit[3] || '').trim(),
                  };
                }
              }
              return {
                startSec: index * defaultDurationSec,
                endSec: (index + 1) * defaultDurationSec,
                text: line,
              };
            }
            if (!entry || typeof entry !== 'object') return null;
            const row = entry as Record<string, unknown>;
            const start =
              this.toSeconds(row.startSec ?? row.start ?? row.start_time ?? row.from) ?? null;
            const end =
              this.toSeconds(row.endSec ?? row.end ?? row.end_time ?? row.to) ?? null;
            const text =
              typeof row.text === 'string'
                ? row.text
                : typeof row.content === 'string'
                ? row.content
                : typeof row.transcript === 'string'
                ? row.transcript
                : '';
            if (start !== null && end !== null && end > start && text.trim()) {
              return {
                startSec: start,
                endSec: end,
                text: text.trim(),
              };
            }
            if (text.trim()) {
              return {
                startSec: index * defaultDurationSec,
                endSec: (index + 1) * defaultDurationSec,
                text: text.trim(),
              };
            }
            return null;
          })
          .filter((entry): entry is { startSec: number; endSec: number; text: string } => Boolean(entry))
      : [];

    if (fromObjects.length) {
      return fromObjects.sort((a, b) => a.startSec - b.startSec);
    }

    const transcript = String(transcriptFallback || '').trim();
    if (!transcript) return [];
    const parts = transcript
      .split(/[\r\n]+|(?<=[。！？!?])|(?<=[.;；])/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 18);
    return parts.map((part, index) => ({
      startSec: index * defaultDurationSec,
      endSec: (index + 1) * defaultDurationSec,
      text: part,
    }));
  }

  private toSeconds(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const text = value.trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) {
      return Number(text);
    }
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/);
    if (!match) return null;
    const hour = Number(match[3] ? match[1] : 0);
    const minute = Number(match[3] ? match[2] : match[1]);
    const second = Number(match[3] ? match[3] : match[2]);
    const ms = Number((match[4] || '0').padEnd(3, '0').slice(0, 3));
    return hour * 3600 + minute * 60 + second + ms / 1000;
  }

  private formatTimeSpan(startSec: number, endSec: number) {
    return `${this.toTimeLabel(startSec)}-${this.toTimeLabel(endSec)}`;
  }

  private toTimeLabel(totalSec: number) {
    const sec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
        .toString()
        .padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  private dedupeStrings(values: string[]) {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = String(value || '').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  private buildSuggestionsFromScoring(segments: ContentScoreSegment[]) {
    const lowSegments = [...segments].sort((a, b) => a.score - b.score).slice(0, 3);
    return lowSegments.map((segment) => {
      const reason = segment.reason || 'weak segment signal';
      return `Optimize [${this.formatTimeSpan(segment.startSec, segment.endSec)}] ${segment.outlineTitle}: ${reason}`;
    });
  }

  private buildLocalAnalysis(item: MaterialAnalysisItem): LocalAnalysis {
    const title = item.title || '';
    const desc = item.desc || '';
    const combinedText = `${title} ${desc}`.trim();
    const tokens = this.tokenize(combinedText);
    const textLength = combinedText.length;

    const likes = this.safeNum(item.likedCount);
    const comments = this.safeNum(item.commentCount);
    const shares = this.safeNum(item.shareCount);
    const collects = this.safeNum(item.collectedCount);
    const followers = this.safeNum(item.followerCount);
    const interactions = likes + comments * 1.4 + shares * 1.6 + collects * 1.5;
    const interactionRate = followers > 0 ? interactions / followers : null;

    const hasVideo = this.isVideoUrl(item.contentUrl) || this.isVideoUrl(item.coverUrl);
    const durationSec = this.estimateDurationSec(hasVideo, textLength, interactions);

    const hookHits = this.includesAny(combinedText.toLowerCase(), HOOK_KEYWORDS);
    const ctaHits = this.includesAny(combinedText.toLowerCase(), CTA_KEYWORDS);
    const emotionHits = this.includesAny(combinedText.toLowerCase(), EMOTION_KEYWORDS);
    const punctuationCount = (combinedText.match(/[锛屻€傦紒锛熴€?.!?]/g) || []).length;

    const speechRateRaw = (tokens.length / Math.max(durationSec, 1)) * 4.5;
    const speechRate: 'slow' | 'medium' | 'fast' =
      speechRateRaw >= 2.4 ? 'fast' : speechRateRaw <= 1.4 ? 'slow' : 'medium';
    const pauseDensity = this.clamp(
      Math.round((punctuationCount / Math.max(textLength, 1)) * 1200),
      0,
      100
    );
    const emotion: 'stable' | 'positive' | 'high_arousal' =
      emotionHits.length >= 3 || (combinedText.match(/!/g) || []).length >= 3
        ? 'high_arousal'
        : emotionHits.length >= 1
        ? 'positive'
        : 'stable';

    const subtitleDensity = this.clamp(Math.round((tokens.length / Math.max(durationSec, 1)) * 18), 8, 100);
    const visualHookStrength = this.clamp(40 + hookHits.length * 12 + (hasVideo ? 12 : 0), 0, 100);
    const sceneSwitchDensity = this.clamp(
      Math.round((hasVideo ? 48 : 26) + Math.min(20, punctuationCount * 2.2)),
      0,
      100
    );

    const hookStrength = this.clamp(
      Math.round(32 + hookHits.length * 14 + (likes > 3000 ? 8 : 0)),
      0,
      100
    );
    const informationDensity = this.clamp(
      Math.round(
        28 + Math.min(32, tokens.length * 0.9) + Math.min(14, punctuationCount * 1.4) + (comments > 200 ? 8 : 0)
      ),
      0,
      100
    );
    const emotionStrength = this.clamp(
      Math.round(24 + emotionHits.length * 14 + (shares > 120 ? 10 : 0) + ((combinedText.match(/!/g) || []).length >= 2 ? 8 : 0)),
      0,
      100
    );
    const conversionStrength = this.clamp(
      Math.round(22 + ctaHits.length * 16 + (collects > 150 ? 10 : 0) + (comments > 120 ? 6 : 0)),
      0,
      100
    );
    const rhythmControl = this.clamp(
      Math.round(30 + (hasVideo ? 14 : 8) + (durationSec <= 60 ? 12 : 6) + (speechRate === 'medium' ? 8 : speechRate === 'fast' ? 6 : 4)),
      0,
      100
    );
    const visualSignal = this.clamp(
      Math.round(30 + (hasVideo ? 18 : 10) + visualHookStrength * 0.35 + sceneSwitchDensity * 0.2),
      0,
      100
    );

    const dimensions: LocalAnalysis['scoreLayer']['dimensions'] = [
      {
        id: 'hook',
        name: 'Hook',
        score: hookStrength,
        weight: 0.24,
        reason: hookHits.length ? `Hook words: ${hookHits.slice(0, 3).join(', ')}` : 'Weak opening hook',
      },
      {
        id: 'information_density',
        name: 'Info Density',
        score: informationDensity,
        weight: 0.22,
        reason: `Tokens ${tokens.length}, pause density ${pauseDensity}%`,
      },
      {
        id: 'emotion',
        name: 'Emotion',
        score: emotionStrength,
        weight: 0.18,
        reason: emotion === 'high_arousal' ? 'High arousal expression' : emotion === 'positive' ? 'Positive tone' : 'Stable tone',
      },
      {
        id: 'conversion',
        name: 'Conversion',
        score: conversionStrength,
        weight: 0.18,
        reason: ctaHits.length ? `CTA words: ${ctaHits.slice(0, 3).join(', ')}` : 'Weak CTA',
      },
      {
        id: 'rhythm',
        name: 'Rhythm',
        score: rhythmControl,
        weight: 0.18,
        reason: `Duration ${durationSec}s, speech ${speechRate}`,
      },
    ];

    const overallScore = this.clamp(
      Math.round(dimensions.reduce((sum, dim) => sum + dim.score * dim.weight, 0)),
      0,
      100
    );
    const level: 'S' | 'A' | 'B' | 'C' =
      overallScore >= 82 ? 'S' : overallScore >= 70 ? 'A' : overallScore >= 58 ? 'B' : 'C';
    const confidence = this.clamp(
      Math.round(44 + (title ? 10 : 0) + (desc ? 12 : 0) + (followers > 0 ? 10 : 0) + 6),
      40,
      98
    );

    const industry = ['general'];
    const styleTags = this.calcStyleTags(combinedText.toLowerCase());
    const hotKeywords = this.extractKeywords(combinedText).slice(0, 8);
    const featureTags = [
      hookStrength >= 75 ? 'strong-hook' : 'hook-needs-work',
      informationDensity >= 70 ? 'high-info-density' : 'normal-info-density',
      emotionStrength >= 70 ? 'emotion-driven' : 'emotion-stable',
      conversionStrength >= 68 ? 'cta-clear' : 'cta-weak',
      visualSignal >= 70 ? 'visual-strong' : 'visual-mid',
    ];

    const timeline = this.calcTimeline(
      durationSec,
      hookStrength,
      informationDensity,
      emotionStrength,
      conversionStrength,
      rhythmControl
    );

    return {
      parseLayer: {
        textLength,
        tokenCount: tokens.length,
        interactionTotal: Math.round(interactions),
        interactionRate: interactionRate === null ? null : Number(interactionRate.toFixed(4)),
        estimatedDurationSec: durationSec,
        hasVideo,
        hasAudioSignal: hasVideo || Boolean(desc || title),
        audio: {
          speechRate,
          emotion,
          pauseDensity,
          ctaKeywords: ctaHits,
        },
        video: {
          subtitleDensity,
          visualHookStrength,
          sceneSwitchDensity,
        },
      },
      featureLayer: {
        hookStrength,
        informationDensity,
        emotionStrength,
        conversionStrength,
        rhythmControl,
        visualSignal,
      },
      scoreLayer: {
        overallScore,
        level,
        dimensions,
        confidence,
      },
      tagLayer: {
        industry,
        styleTags,
        featureTags,
        hotKeywords,
      },
      timeline,
    };
  }

  private calcTimeline(
    durationSec: number,
    hookStrength: number,
    informationDensity: number,
    emotionStrength: number,
    conversionStrength: number,
    rhythmControl: number
  ) {
    const segmentCount = 6;
    const segmentSec = durationSec / segmentCount;
    const baseHeats = [
      35 + hookStrength * 0.6,
      20 + hookStrength * 0.25 + informationDensity * 0.35,
      18 + informationDensity * 0.4 + rhythmControl * 0.3,
      16 + emotionStrength * 0.55 + rhythmControl * 0.25,
      20 + informationDensity * 0.35 + conversionStrength * 0.35,
      15 + conversionStrength * 0.6 + emotionStrength * 0.2,
    ];
    const reasons = [
      'Opening hook',
      'Core point appears',
      'Dense value delivery',
      'Emotion boost',
      'Summary and mapping',
      'CTA close',
    ];
    return baseHeats.map((value, idx) => {
      const heat = this.clamp(Math.round(value), 0, 100);
      const start = Math.round(idx * segmentSec);
      const end = Math.round((idx + 1) * segmentSec);
      return {
        index: idx + 1,
        startSec: start,
        endSec: Math.max(end, start + 1),
        heat,
        isHighEnergy: heat >= 75,
        reason: reasons[idx],
      };
    });
  }

  private estimateDurationSec(hasVideo: boolean, textLength: number, interactions: number) {
    const base = hasVideo ? 32 : 18;
    const textFactor = Math.min(28, Math.round(textLength / 12));
    const interactionFactor = Math.min(20, Math.round(Math.log10(Math.max(interactions, 10)) * 6));
    return this.clamp(base + textFactor + interactionFactor, 15, 130);
  }

  private calcStyleTags(text: string) {
    const rules: Array<{ tag: string; words: string[] }> = [
      { tag: 'tutorial', words: ['step', 'how', 'tips'] },
      { tag: 'review', words: ['review', 'compare', 'test'] },
      { tag: 'checklist', words: ['list', 'must', 'avoid'] },
      { tag: 'story', words: ['story', 'experience', 'real'] },
    ];
    const tags = rules
      .filter((r) => r.words.some((w) => text.includes(w)))
      .map((r) => r.tag);
    return tags.length ? tags : ['experience'];
  }

  private tokenize(text: string) {
    const hits = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g) || [];
    return hits.filter((token) => !STOP_WORDS.has(token));
  }

  private includesAny(text: string, words: string[]) {
    return words.filter((w) => text.includes(w));
  }

  private normalizeHttp(url?: string) {
    if (!url) return '';
    const value = String(url).trim();
    if (!/^https?:\/\//i.test(value)) {
      return '';
    }
    try {
      const parsed = new URL(value);
      // The model endpoint is noticeably more stable with https media URLs.
      if (parsed.protocol === 'http:') {
        parsed.protocol = 'https:';
      }
      return parsed.toString();
    } catch {
      return '';
    }
  }

  private isVideoUrl(url?: string) {
    if (!url) return false;
    return /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url.toLowerCase()) || url.toLowerCase().includes('/video/');
  }

  private isAudioUrl(url?: string) {
    if (!url) return false;
    return /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url.toLowerCase());
  }

  private safeNum(value?: number) {
    return Number.isFinite(value) ? Number(value) : 0;
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
  }

  private avg(values: number[]) {
    const list = values.filter((v) => Number.isFinite(v) && v > 0);
    if (!list.length) return 0;
    return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  }

  private shortSummary(text: string) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private extractKeywords(text: string) {
    const tokens = String(text || '')
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    const count = new Map<string, number>();
    tokens.forEach((t) => count.set(t, (count.get(t) || 0) + 1));
    return Array.from(count.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);
  }

  private safeDate(value?: string) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.valueOf())) return null;
    return d;
  }

  private parseStringArray(value: unknown) {
    if (Array.isArray(value)) {
      return value
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(/\r?\n|,|锛寍;|锛泑\|/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [];
  }

  private parseJson(text: string) {
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }

  private extractMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
          return String((entry as any).text);
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  private extractDoubaoResponsesText(payload: unknown): string {
    const data = payload as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') {
      return '';
    }
    const direct = data.output_text;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }
    const outputs = Array.isArray(data.output)
      ? data.output
      : Array.isArray((data as any)?.response?.output)
      ? (data as any).response.output
      : [];
    const segments: string[] = [];
    for (const output of outputs as any[]) {
      if (typeof output?.text === 'string' && output.text.trim()) {
        segments.push(output.text.trim());
      }
      const content = Array.isArray(output?.content) ? output.content : [];
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          segments.push(part.text.trim());
        } else if (
          typeof part?.output_text === 'string' &&
          part.output_text.trim()
        ) {
          segments.push(part.output_text.trim());
        } else if (typeof part?.content === 'string' && part.content.trim()) {
          segments.push(part.content.trim());
        }
      }
    }
    return segments.join('\n').trim();
  }

  private detectAudioFormat(url: string) {
    const manual = String(process.env.DOUBAO_ASR_AUDIO_FORMAT || '')
      .trim()
      .toLowerCase();
    if (manual) {
      return manual;
    }
    const lower = url.toLowerCase();
    if (lower.includes('.raw')) return 'raw';
    if (lower.includes('.ogg')) return 'ogg';
    if (lower.includes('.wav')) return 'wav';
    if (lower.includes('.m4a')) return 'm4a';
    if (lower.includes('.aac')) return 'aac';
    if (lower.includes('.flac')) return 'flac';
    if (lower.includes('.mp4') || lower.includes('.mov') || lower.includes('.webm')) {
      return 'mp3';
    }
    return 'mp3';
  }

  private safeStringify(value: unknown) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value ?? '');
    }
  }

  private buildRawModelText(primaryText: string, rawResponse: unknown) {
    const text = String(primaryText || '').trim();
    const raw = this.safeStringify(rawResponse);
    if (!text) return raw;
    if (!raw) return text;
    return `${text}\n\n---RAW_RESPONSE---\n${raw}`;
  }

  private async execCommand(
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal
  ) {
    this.throwIfCancelled(signal);
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const closeWithError = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `${command} exited with code ${code ?? 'unknown'}: ${String(stderr || stdout).slice(0, 500)}`
          )
        );
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        closeWithError(`${command} timeout after ${timeoutMs}ms`);
      }, timeoutMs);
      const onAbort = () => {
        child.kill('SIGKILL');
        closeWithError(`${this.cancelMarker} ${command} aborted by cancellation`);
      };
      signal?.addEventListener('abort', onAbort);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        closeWithError(`${command} spawn error: ${error.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        finish(code);
      });
    });
  }

  private async fetchJsonWithRetry<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    retries: number,
    options?: FetchJsonOptions
  ): Promise<T> {
    let lastError: unknown;
    const attempts = Math.max(1, retries + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.fetchJson<T>(url, init, timeoutMs + attempt * 20_000, options);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
        const shouldRetry =
          attempt < attempts - 1 &&
          !this.isCancelError(error) &&
          (message.includes('aborted') ||
            message.includes('timeout') ||
            message.includes('429') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504') ||
            message.includes('network'));
        if (!shouldRetry) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'unknown request error'));
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    options?: FetchJsonOptions
  ): Promise<T> {
    this.throwIfCancelled(options?.signal);
    const timeoutController = new AbortController();
    const compositeController = new AbortController();
    let timedOut = false;
    const onTimeoutAbort = () => {
      timedOut = true;
      if (!compositeController.signal.aborted) {
        compositeController.abort();
      }
    };
    const onExternalAbort = () => {
      if (!compositeController.signal.aborted) {
        compositeController.abort();
      }
    };
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timeoutController.signal.addEventListener('abort', onTimeoutAbort);
    options?.signal?.addEventListener('abort', onExternalAbort);
    try {
      const response = await fetch(url, { ...init, signal: compositeController.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 300)}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (options?.signal?.aborted && !timedOut) {
          throw new Error(`${this.cancelMarker} request aborted by cancellation`);
        }
        throw new Error(`timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    this.throwIfCancelled(signal);
    const timeoutController = new AbortController();
    const compositeController = new AbortController();
    let timedOut = false;
    const onTimeoutAbort = () => {
      timedOut = true;
      if (!compositeController.signal.aborted) {
        compositeController.abort();
      }
    };
    const onExternalAbort = () => {
      if (!compositeController.signal.aborted) {
        compositeController.abort();
      }
    };
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timeoutController.signal.addEventListener('abort', onTimeoutAbort);
    signal?.addEventListener('abort', onExternalAbort);
    try {
      return await fetch(url, { ...init, signal: compositeController.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (signal?.aborted && !timedOut) {
          throw new Error(`${this.cancelMarker} request aborted by cancellation`);
        }
        throw new Error(`timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async delayWithCancel(ms: number, signal?: AbortSignal) {
    this.throwIfCancelled(signal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`${this.cancelMarker} delay aborted by cancellation`));
      };
      signal?.addEventListener('abort', onAbort);
    });
  }

  private isCancelError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    return message.includes(this.cancelMarker);
  }

  private throwIfCancelled(signal?: AbortSignal) {
    if (!signal?.aborted) {
      return;
    }
    throw new Error(`${this.cancelMarker} analysis cancelled`);
  }

  private async waitForLatestAnalysis(orgId: string, platform: string, externalId: string) {
    const attempts = 6;
    for (let i = 0; i < attempts; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const existing = await this.getLatestAnalysis(orgId, platform, externalId);
      if (existing) {
        return existing;
      }
    }
    return null;
  }
}


