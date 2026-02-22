import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

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
  rawText: string;
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
  analysis: LocalAnalysis;
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

  async analyzeAndStore(orgId: string, item: MaterialAnalysisItem): Promise<StoredPayload> {
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

    const payload = await this.buildAnalysisPayload(item);
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

  private async buildAnalysisPayload(item: MaterialAnalysisItem): Promise<StoredPayload> {
    const base = this.buildLocalAnalysis(item);
    const apiKey = this.resolveApiKey();
    const fallbackVision = this.buildVisionFallback(item, this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl));
    const fallbackAsr = this.buildAsrFallback(item, this.normalizeHttp(item.contentUrl));
    const fallbackSemantic = this.buildSemanticFallback(item, fallbackVision, fallbackAsr);
    if (!apiKey) {
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
        analysis: base,
      };
    }

    const [vision, asr] = await Promise.all([
      this.runVisionAnalysis(item, apiKey),
      this.runAsrAnalysis(item, apiKey),
    ]);
    const semantic = await this.runSemanticAnalysis(item, vision, asr, apiKey);

    const merged = this.mergeAiToLocal(base, vision, asr, semantic);
    const globalConfidence = this.avg([
      vision.confidence * 100,
      asr.confidence * 100,
      semantic.confidence * 100,
    ]);

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
        highlights: semantic.highlights.slice(0, 6),
        optimizationSuggestions: semantic.insights.slice(0, 5),
        reusableScriptTemplate:
          'Open with a bold claim in 3s, then 3 concrete points, add proof, end with CTA',
      },
      aiDetailLayer: {
        vision: {
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
      analysis: merged,
    };
  }

  private mergeAiToLocal(
    base: LocalAnalysis,
    vision: VisionResult,
    asr: AsrResult,
    semantic: SemanticResult
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
    copy.scoreLayer.confidence = this.clamp(
      Math.round(this.avg([vision.confidence * 100, asr.confidence * 100, semantic.confidence * 100])),
      40,
      99
    );
    return copy;
  }

  private resolveApiKey() {
    return process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  }

  private compatibleBaseUrl() {
    return (
      process.env.QWEN_BASE_URL ||
      process.env.QWEN_API_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/$/, '');
  }

  private async runVisionAnalysis(item: MaterialAnalysisItem, apiKey: string): Promise<VisionResult> {
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
      '你是短视频视觉分析器，请只返回JSON。',
      'JSON格式：{"summary":"","keywords":[""],"scenes":[""],"keyframes":[""]}',
      '要求：scenes输出场景列表；keyframes输出关键帧描述（可带时间）。',
      `title: ${item.title || ''}`,
      `desc: ${item.desc || ''}`,
    ].join('\n');
    const errors: string[] = [];
    for (const candidate of candidates) {
      const isVideo = candidate.mediaType === 'video';
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
          isVideo ? 2 : 1
        );
        const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
        const parsed = this.parseJson(text);
        const keyframes =
          this.parseKeyframes(parsed.keyframes).length > 0
            ? this.parseKeyframes(parsed.keyframes)
            : this.parseKeyframes((parsed as any).frames);
        return {
          modelUsed: model,
          confidence: isVideo ? 0.84 : 0.8,
          mediaUrl: candidate.mediaUrl,
          mediaType: candidate.mediaType,
          summary: typeof parsed.summary === 'string' ? parsed.summary : this.shortSummary(item.desc || ''),
          keywords: this.parseStringArray(parsed.keywords),
          scenes: this.parseStringArray(parsed.scenes),
          keyframes,
          rawText: this.buildRawModelText(text, data),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        errors.push(`${candidate.mediaType}:${message}`);
        this.logger.warn(`runVisionAnalysis candidate fallback (${candidate.mediaType}): ${message}`);
      }
    }

    return this.buildVisionFallback(item, candidates[0]?.mediaUrl || '', errors.join(' | '));
  }

  private async runAsrAnalysis(item: MaterialAnalysisItem, apiKey: string): Promise<AsrResult> {
    const audioModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
    const videoAsrModel = process.env.QWEN_ASR_VIDEO_MODEL || process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const mediaSource = this.normalizeHttp(item.contentUrl) || this.normalizeHttp(item.coverUrl);
    if (!mediaSource) {
      return this.buildAsrFallback(item, '');
    }

    try {
      if (this.isAudioUrl(mediaSource)) {
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
                        data: mediaSource,
                        format: this.detectAudioFormat(mediaSource),
                      },
                    },
                    {
                      type: 'text',
                      text: 'Return transcript text only.',
                    },
                  ],
                },
              ],
            }),
          },
          120_000,
          2
        );
        const msg = data?.choices?.[0]?.message;
        const transcript = this.extractMessageText(msg?.content);
        const ann = Array.isArray(msg?.annotations) ? msg.annotations[0] || {} : {};
        return {
          modelUsed: audioModel,
          confidence: transcript ? 0.85 : 0.62,
          audioSource: mediaSource,
          transcript: transcript || this.shortSummary(item.desc || ''),
          language: typeof ann.language === 'string' ? ann.language : 'unknown',
          emotion: typeof ann.emotion === 'string' ? ann.emotion : 'stable',
          rawText: this.buildRawModelText(transcript, data),
        };
      }

      if (this.isVideoUrl(mediaSource)) {
        const videoPrompt = [
          '请将视频中的语音内容完整转写，并返回JSON。',
          'JSON格式：{"transcript":"","language":"","emotion":"","segments":[""]}',
          '要求：transcript尽量完整，不要摘要。',
          `title: ${item.title || ''}`,
          `desc: ${item.desc || ''}`,
        ].join('\n');
        const data = await this.fetchJsonWithRetry<any>(
          endpoint,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: videoAsrModel,
              temperature: 0,
              messages: [
                { role: 'system', content: 'JSON only.' },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: videoPrompt },
                    { type: 'video_url', video_url: { url: mediaSource } },
                  ],
                },
              ],
            }),
          },
          120_000,
          2
        );
        const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
        const parsed = this.parseJson(text);
        const segments = this.parseStringArray(parsed.segments);
        const transcript =
          typeof parsed.transcript === 'string' && parsed.transcript.trim()
            ? parsed.transcript.trim()
            : segments.join('\n') || text;
        return {
          modelUsed: `${videoAsrModel}(video-audio)`,
          confidence: transcript ? 0.8 : 0.62,
          audioSource: mediaSource,
          transcript: transcript || this.shortSummary(item.desc || ''),
          language: typeof parsed.language === 'string' ? parsed.language : 'unknown',
          emotion: typeof parsed.emotion === 'string' ? parsed.emotion : 'stable',
          rawText: this.buildRawModelText(text, data),
        };
      }

      return this.buildAsrFallback(item, mediaSource, 'unsupported media type');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runAsrAnalysis fallback: ${message}`);
      return this.buildAsrFallback(item, mediaSource, message);
    }
  }

  private async runSemanticAnalysis(
    item: MaterialAnalysisItem,
    vision: VisionResult,
    asr: AsrResult,
    apiKey: string
  ): Promise<SemanticResult> {
    const model = process.env.QWEN_SEMANTIC_MODEL || 'qwen3.5-plus';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const prompt = [
      '你是短视频内容策略分析师，请只输出JSON。',
      '请结合视觉、语音和文案进行360度分析，尤其判断口播/非口播、主播角色、表达风格和权威背书方式。',
      'JSON格式：{"summary":"","highlights":[""],"keywords":[""],"insights":[""],"tone":"","fullSummary360":"","profile360":{"speakingFormat":"","narratorRole":"","productionApproach":[""],"expressionStyle":[""],"persuasionPath":[""],"authoritySignals":[""],"complianceSignals":[""],"audienceFit":[""],"risks":[""],"reusableAngles":[""]}}',
      `title: ${item.title || ''}`,
      `desc: ${item.desc || ''}`,
      `visual summary: ${vision.summary || ''}`,
      `asr transcript: ${asr.transcript || ''}`,
      `visual keyframes: ${vision.keyframes.join(' | ')}`,
    ].join('\n');

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
        60_000
      );
      const text = this.extractMessageText(data?.choices?.[0]?.message?.content);
      const parsed = this.parseJson(text);
      const parsedProfile = this.parseProfile360(parsed.profile360);
      const fallbackProfile = this.buildFallbackProfile360(item, vision, asr);
      const profile360: Profile360 = {
        speakingFormat:
          parsedProfile.speakingFormat !== '未知'
            ? parsedProfile.speakingFormat
            : fallbackProfile.speakingFormat,
        narratorRole:
          parsedProfile.narratorRole !== '未知'
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
        modelUsed: model,
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
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runSemanticAnalysis fallback: ${message}`);
      return this.buildSemanticFallback(item, vision, asr, message);
    }
  }

  private buildVisionFallback(item: MaterialAnalysisItem, mediaUrl: string, error?: string): VisionResult {
    return {
      modelUsed: 'local-heuristic',
      confidence: 0.56,
      mediaUrl,
      mediaType: !mediaUrl ? 'unknown' : this.isVideoUrl(mediaUrl) ? 'video' : 'image',
      summary: this.shortSummary(item.desc || ''),
      keywords: this.extractKeywords(`${item.title || ''} ${item.desc || ''}`),
      scenes: [],
      keyframes: [],
      rawText: error ? `fallback: ${error}` : '',
    };
  }

  private buildAsrFallback(item: MaterialAnalysisItem, audioSource: string, error?: string): AsrResult {
    return {
      modelUsed: 'local-heuristic',
      confidence: 0.55,
      audioSource,
      transcript: this.shortSummary(item.desc || ''),
      language: 'unknown',
      emotion: 'stable',
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
      /医美|皮肤|医生|医院|clinic|aesthetic|美容|术后|治疗/.test(desc) ||
      /医|院|医生|诊所/.test((item.authorName || '').toLowerCase());
    const hasTranscript = (asr.transcript || '').trim().length > 20;
    return {
      speakingFormat: hasTranscript ? '口播/讲解' : vision.mediaType === 'video' ? '弱口播或字幕驱动' : '图文/静态展示',
      narratorRole: isMedical ? '医生/机构专业账号倾向' : '达人/品牌通用账号倾向',
      productionApproach: vision.scenes.slice(0, 3),
      expressionStyle: [
        '信息密度驱动',
        hasTranscript ? '口语化表达' : '画面+字幕表达',
      ],
      persuasionPath: isMedical
        ? ['专业背景背书', '案例/功效解释', '行动引导']
        : ['痛点引入', '卖点展开', '行动引导'],
      authoritySignals: isMedical ? ['专业身份', '机构/资质', '术语解释'] : ['产品特性', '体验反馈'],
      complianceSignals: isMedical
        ? ['避免疗效承诺', '避免绝对化用语', '增加风险提示']
        : ['避免夸大宣传', '强调体验差异因人而异'],
      audienceFit: isMedical ? ['医美意向人群', '功效理性决策人群'] : ['泛兴趣消费人群'],
      risks: isMedical ? ['平台医疗合规风险', '过度承诺风险'] : ['信息同质化风险'],
      reusableAngles: [
        '开场3秒给出核心结论',
        '先讲适用人群，再讲证据与限制',
        '结尾明确咨询/私信行动点',
      ],
    };
  }

  private buildFallbackFullSummary360(item: MaterialAnalysisItem, profile360: Profile360) {
    const title = item.title || '该素材';
    return [
      `素材《${title}》以${profile360.speakingFormat}为主，主播角色判断为${profile360.narratorRole}。`,
      `表达风格：${profile360.expressionStyle.join('、') || '信息表达'}；说服路径：${profile360.persuasionPath.join(' -> ') || '卖点递进'}。`,
      `权威信号：${profile360.authoritySignals.join('、') || '暂无明显权威背书'}。`,
      `建议：${profile360.complianceSignals.join('；') || '保持表达克制并强化证据链'}。`,
    ].join('\n');
  }

  private parseKeyframes(value: unknown) {
    if (typeof value === 'string') {
      return value
        .split(/\r?\n|;|；/)
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

  private parseProfile360(value: unknown): Profile360 {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      speakingFormat:
        typeof raw.speakingFormat === 'string' && raw.speakingFormat.trim()
          ? raw.speakingFormat.trim()
          : '未知',
      narratorRole:
        typeof raw.narratorRole === 'string' && raw.narratorRole.trim()
          ? raw.narratorRole.trim()
          : '未知',
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
    const punctuationCount = (combinedText.match(/[，。！？、,.!?]/g) || []).length;

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
        .split(/\r?\n|,|，|;|；|\|/)
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

  private detectAudioFormat(url: string) {
    const lower = url.toLowerCase();
    if (lower.includes('.wav')) return 'wav';
    if (lower.includes('.m4a')) return 'm4a';
    if (lower.includes('.aac')) return 'aac';
    if (lower.includes('.ogg')) return 'ogg';
    if (lower.includes('.flac')) return 'flac';
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

  private async fetchJsonWithRetry<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    retries: number
  ): Promise<T> {
    let lastError: unknown;
    const attempts = Math.max(1, retries + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.fetchJson<T>(url, init, timeoutMs + attempt * 20_000);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
        const shouldRetry =
          attempt < attempts - 1 &&
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

  private async fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 300)}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
