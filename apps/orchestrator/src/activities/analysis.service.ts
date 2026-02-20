import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

type MediaAssetInput = {
  type: string;
  url: string;
  localPath?: string | null;
};

type VisionResult = {
  modelUsed: string;
  confidence: number;
  summary: string;
  keywords: string[];
  ocrText: string;
  scenes: string[];
};

type AsrResult = {
  modelUsed: string;
  confidence: number;
  transcript: string;
  language: string;
  emotion: string;
};

type SemanticResult = {
  modelUsed: string;
  confidence: number;
  summary: string;
  highlights: string[];
  tone: string;
  keywords: string[];
  insights: string[];
};

type AudioInput = {
  asrInput: string | null;
  format: string;
};

export type SourceContentAnalysisInput = {
  sourceContentId: string;
  title?: string | null;
  content?: string | null;
  mediaAssets: MediaAssetInput[];
};

export type SourceContentAnalysisOutput = {
  sourceContentId: string;
  type: string;
  modelUsed: string;
  confidence: number;
  result: Record<string, unknown>;
};

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private ffmpegAvailable: boolean | null = null;

  async analyzeContents(
    sourceContents: SourceContentAnalysisInput[]
  ): Promise<SourceContentAnalysisOutput[]> {
    const outputs: SourceContentAnalysisOutput[] = [];
    for (const sourceContent of sourceContents) {
      outputs.push(await this.analyzeOne(sourceContent));
    }
    return outputs;
  }

  private async analyzeOne(
    sourceContent: SourceContentAnalysisInput
  ): Promise<SourceContentAnalysisOutput> {
    const videoAsset = sourceContent.mediaAssets.find((asset) => asset.type === 'video');
    if (!videoAsset) {
      return this.createTextFallback(sourceContent, 'NO_VIDEO_ASSET');
    }

    const workspace = join(tmpdir(), 'content-factory-analysis', sourceContent.sourceContentId);
    await fs.mkdir(workspace, { recursive: true });

    try {
      const videoPath = await this.prepareVideo(videoAsset, workspace);
      const frames = await this.extractFrames(videoPath, workspace);
      const publicVideoUrl = this.normalizePublicUrl(videoAsset.url);
      const audioAsset = sourceContent.mediaAssets.find((asset) => asset.type === 'audio');
      const audioInput = await this.prepareAudioInput(
        workspace,
        videoPath,
        publicVideoUrl,
        this.normalizePublicUrl(audioAsset?.url || '')
      );

      const [vision, asr] = await Promise.all([
        this.runVisionAnalysis(sourceContent, frames, publicVideoUrl),
        this.runAsrRecognition(sourceContent, audioInput),
      ]);
      const semantic = await this.runSemanticAnalysis(sourceContent, {
        transcript: asr.transcript,
        visualSummary: vision.summary,
        ocrText: vision.ocrText,
      });

      const transcript =
        asr.transcript || semantic.summary || this.shortSummary(sourceContent.content || '');
      const modelUsed = this.joinModelUsed([
        vision.modelUsed,
        asr.modelUsed,
        semantic.modelUsed,
      ]);

      return {
        sourceContentId: sourceContent.sourceContentId,
        type: 'video_analysis',
        modelUsed,
        confidence: this.combineConfidence([
          vision.confidence,
          asr.confidence,
          semantic.confidence,
        ]),
        result: {
          title: sourceContent.title || null,
          shortSummary: this.shortSummary(sourceContent.content || ''),
          video: {
            source: videoAsset.url,
            frameCount: frames.length,
            ffmpegAvailable: this.ffmpegAvailable === true,
          },
          ocrText: vision.ocrText,
          asrTranscript: transcript,
          visualSummary: vision.summary,
          keywords: this.mergeKeywords([vision.keywords, semantic.keywords]),
          scenes: vision.scenes,
          speechAnalysis: {
            language: asr.language,
            emotion: asr.emotion,
            audioSummary: semantic.summary,
            highlights: semantic.highlights,
            tone: semantic.tone,
            insights: semantic.insights,
          },
          semanticAnalysis: {
            summary: semantic.summary,
            highlights: semantic.highlights,
            tone: semantic.tone,
            keywords: semantic.keywords,
            insights: semantic.insights,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'analysis failed';
      this.logger.warn(`analyzeOne fallback: ${message}`);
      return this.createTextFallback(sourceContent, message);
    }
  }

  private normalizePublicUrl(url: string | null | undefined) {
    if (!url || !/^https?:\/\//i.test(url)) {
      return '';
    }
    return url.trim();
  }

  private joinModelUsed(models: string[]) {
    const merged = Array.from(
      new Set(
        models
          .map((item) => item.trim())
          .filter((item) => Boolean(item) && item !== 'local-heuristic')
      )
    );
    return merged.length ? merged.join(', ') : 'local-heuristic';
  }

  private combineConfidence(scores: number[]) {
    const values = scores.filter((item) => Number.isFinite(item) && item > 0);
    if (!values.length) {
      return 0.5;
    }
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Number(avg.toFixed(2));
  }

  private mergeKeywords(groups: string[][]) {
    const merged = groups.flat().map((item) => item.trim()).filter(Boolean);
    return Array.from(new Set(merged)).slice(0, 12);
  }

  private async prepareVideo(asset: MediaAssetInput, workspace: string) {
    if (asset.localPath) {
      return asset.localPath;
    }
    if (asset.url.startsWith('local:')) {
      return asset.url.replace(/^local:/, '');
    }
    return this.downloadVideo(asset.url, workspace);
  }

  private async downloadVideo(url: string, workspace: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': 'postiz-content-factory/1.0',
        },
      });
      if (!response.ok) {
        throw new Error(`download failed: ${response.status}`);
      }
      const body = await response.arrayBuffer();
      const extension = this.guessExtension(url, response.headers.get('content-type'));
      const filePath = join(workspace, `video-${randomUUID()}${extension}`);
      await fs.writeFile(filePath, Buffer.from(body));
      return filePath;
    } finally {
      clearTimeout(timeout);
    }
  }

  private guessExtension(url: string, contentType: string | null) {
    const fromUrl = extname(url.split('?')[0] || '');
    if (fromUrl) {
      return fromUrl;
    }
    if (contentType?.includes('webm')) return '.webm';
    if (contentType?.includes('quicktime')) return '.mov';
    return '.mp4';
  }

  private async extractFrames(videoPath: string, workspace: string) {
    const ffmpeg = await this.ensureFfmpeg();
    if (!ffmpeg) {
      return [];
    }

    const outputPattern = join(workspace, 'frame-%02d.jpg');
    await this.runCommand('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vf',
      'fps=1/2',
      '-frames:v',
      '4',
      outputPattern,
    ]);

    const files = await fs.readdir(workspace);
    return files
      .filter((name) => /^frame-\d+\.jpg$/i.test(name))
      .map((name) => join(workspace, name))
      .sort();
  }

  private async prepareAudioInput(
    workspace: string,
    videoPath: string,
    videoSourceUrl: string,
    audioSourceUrl: string
  ): Promise<AudioInput> {
    const extractedAudio = await this.extractAudio(videoPath, workspace);
    if (extractedAudio) {
      return {
        asrInput: await this.toDataUrl(extractedAudio),
        format: this.detectAudioFormat(extractedAudio),
      };
    }

    const sourceUrl = audioSourceUrl || videoSourceUrl || null;
    if (sourceUrl) {
      return {
        asrInput: sourceUrl,
        format: this.detectAudioFormat(sourceUrl),
      };
    }

    return {
      asrInput: null,
      format: 'mp3',
    };
  }

  private async extractAudio(videoPath: string, workspace: string) {
    const ffmpeg = await this.ensureFfmpeg();
    if (!ffmpeg) {
      return '';
    }
    const maxSeconds = Math.max(
      Number(process.env.ANALYSIS_AUDIO_MAX_SECONDS || 180) || 180,
      15
    );
    const outputPath = join(workspace, `audio-${randomUUID()}.mp3`);
    await this.runCommand('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '64k',
      '-t',
      String(maxSeconds),
      outputPath,
    ]);
    try {
      const stats = await fs.stat(outputPath);
      if (stats.size <= 0) {
        return '';
      }
      return outputPath;
    } catch {
      return '';
    }
  }

  private detectAudioFormat(pathOrUrl: string) {
    const normalized = pathOrUrl.toLowerCase();
    if (normalized.includes('.wav')) return 'wav';
    if (normalized.includes('.flac')) return 'flac';
    if (normalized.includes('.ogg')) return 'ogg';
    if (normalized.includes('.m4a')) return 'm4a';
    return 'mp3';
  }

  private async ensureFfmpeg() {
    if (this.ffmpegAvailable !== null) {
      return this.ffmpegAvailable;
    }
    try {
      await this.runCommand('ffmpeg', ['-version'], 5_000);
      this.ffmpegAvailable = true;
    } catch {
      this.ffmpegAvailable = false;
    }
    return this.ffmpegAvailable;
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

  private async runVisionAnalysis(
    sourceContent: SourceContentAnalysisInput,
    frames: string[],
    publicVideoUrl: string
  ): Promise<VisionResult> {
    const apiKey = this.resolveApiKey();
    if (!apiKey || (!publicVideoUrl && frames.length === 0)) {
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.55,
        summary: this.localSummary(sourceContent),
        keywords: this.extractKeywords(sourceContent),
        ocrText: '',
        scenes: [],
      };
    }

    const model = process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const visualContent: Array<
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'video_url'; video_url: { url: string } }
    > = [];

    if (publicVideoUrl) {
      visualContent.push({
        type: 'video_url',
        video_url: {
          url: publicVideoUrl,
        },
      });
    } else {
      const frameItems = await Promise.all(
        frames.slice(0, 3).map(async (framePath) => ({
          type: 'image_url' as const,
          image_url: {
            url: await this.toDataUrl(framePath),
          },
        }))
      );
      visualContent.push(...frameItems);
    }

    const prompt = [
      '你是爆款短视频分析助手。请从视觉信息与文本中抽取核心内容，并只返回 JSON。',
      '输出格式：{"summary":"","keywords":[""],"ocrText":"","scenes":[""]}',
      `标题：${sourceContent.title || ''}`,
      `正文：${sourceContent.content || ''}`,
    ].join('\n');

    try {
      const payload = await this.fetchJson<{
        choices?: Array<{
          message?: {
            content?: string | Array<{ text?: string }>;
          };
        }>;
      }>(
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
              {
                role: 'system',
                content: '你必须返回 JSON 且不允许输出额外解释。',
              },
              {
                role: 'user',
                content: [{ type: 'text', text: prompt }, ...visualContent],
              },
            ],
          }),
        },
        60_000
      );

      const rawContent = payload.choices?.[0]?.message?.content;
      const text = this.extractMessageText(rawContent);
      const parsed = this.parseJsonPayload(text);

      return {
        modelUsed: model,
        confidence: 0.84,
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary
            : this.localSummary(sourceContent),
        keywords: this.parseStringArray(parsed.keywords).slice(0, 8),
        ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
        scenes: this.parseStringArray(parsed.scenes).slice(0, 8),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runVisionAnalysis fallback: ${message}`);
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.58,
        summary: this.localSummary(sourceContent),
        keywords: this.extractKeywords(sourceContent),
        ocrText: '',
        scenes: [],
      };
    }
  }

  private async runAsrRecognition(
    sourceContent: SourceContentAnalysisInput,
    audioInput: AudioInput
  ): Promise<AsrResult> {
    const apiKey = this.resolveApiKey();
    if (!apiKey || !audioInput.asrInput) {
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.5,
        transcript: this.shortSummary(sourceContent.content || ''),
        language: 'unknown',
        emotion: 'unknown',
      };
    }

    const model = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const inputAudio = {
      data: audioInput.asrInput,
      format: audioInput.format || 'mp3',
    };

    try {
      const payload = await this.fetchJson<{
        choices?: Array<{
          message?: {
            content?: string | Array<{ text?: string }>;
            annotations?: Array<Record<string, unknown>>;
          };
        }>;
      }>(
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
            stream: false,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    input_audio: inputAudio,
                  },
                  {
                    type: 'text',
                    text: '请直接返回音频转写文本，不要加解释。',
                  },
                ],
              },
            ],
          }),
        },
        90_000
      );

      const message = payload.choices?.[0]?.message;
      const transcript = this.extractMessageText(message?.content).trim();
      const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
      const annotation = this.asRecord(annotations[0]);

      return {
        modelUsed: model,
        confidence: transcript ? 0.88 : 0.64,
        transcript: transcript || this.shortSummary(sourceContent.content || ''),
        language:
          typeof annotation.language === 'string' ? annotation.language : 'unknown',
        emotion:
          typeof annotation.emotion === 'string' ? annotation.emotion : 'unknown',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runAsrRecognition fallback: ${message}`);
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.55,
        transcript: this.shortSummary(sourceContent.content || ''),
        language: 'unknown',
        emotion: 'unknown',
      };
    }
  }

  private async runSemanticAnalysis(
    sourceContent: SourceContentAnalysisInput,
    input: {
      transcript: string;
      visualSummary: string;
      ocrText: string;
    }
  ): Promise<SemanticResult> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.52,
        summary: this.shortSummary(sourceContent.content || ''),
        highlights: [] as string[],
        tone: 'unknown',
        keywords: this.extractKeywords(sourceContent),
        insights: [] as string[],
      };
    }

    const model = process.env.QWEN_SEMANTIC_MODEL || 'qwen3.5-plus';
    const endpoint = `${this.compatibleBaseUrl()}/chat/completions`;
    const prompt = [
      '你是短视频语义分析助手。请根据输入信息完成语义理解，只返回 JSON。',
      '输出格式：{"summary":"","highlights":[""],"tone":"","keywords":[""],"insights":[""]}',
      `标题：${sourceContent.title || ''}`,
      `正文：${sourceContent.content || ''}`,
      `ASR转写：${input.transcript || ''}`,
      `视觉摘要：${input.visualSummary || ''}`,
      `OCR文本：${input.ocrText || ''}`,
    ].join('\n');

    try {
      const payload = await this.fetchJson<{
        choices?: Array<{
          message?: {
            content?: string | Array<{ text?: string }>;
          };
        }>;
      }>(
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
              {
                role: 'system',
                content: '你必须仅输出 JSON 对象，不能输出任何解释。',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
          }),
        },
        60_000
      );

      const text = this.extractMessageText(payload.choices?.[0]?.message?.content);
      const parsed = this.parseJsonPayload(text);
      return {
        modelUsed: model,
        confidence: 0.83,
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary
            : this.shortSummary(sourceContent.content || ''),
        highlights: this.parseStringArray(parsed.highlights).slice(0, 6),
        tone: typeof parsed.tone === 'string' ? parsed.tone : 'neutral',
        keywords: this.parseStringArray(parsed.keywords).slice(0, 10),
        insights: this.parseStringArray(parsed.insights).slice(0, 8),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`runSemanticAnalysis fallback: ${message}`);
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.58,
        summary: this.shortSummary(sourceContent.content || ''),
        highlights: [] as string[],
        tone: 'unknown',
        keywords: this.extractKeywords(sourceContent),
        insights: [] as string[],
      };
    }
  }

  private parseStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private extractMessageText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = this.asRecord(value);
      if (typeof obj.text === 'string') {
        return obj.text;
      }
      if (typeof obj.content === 'string') {
        return obj.content;
      }
      return '';
    }
    if (!Array.isArray(value)) {
      return '';
    }
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        const obj = this.asRecord(item);
        if (typeof obj.text === 'string') {
          return obj.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private parseJsonPayload(text: string) {
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        return {};
      }
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }

  private createTextFallback(sourceContent: SourceContentAnalysisInput, reason: string) {
    return {
      sourceContentId: sourceContent.sourceContentId,
      type: 'text_fallback',
      modelUsed: 'local-heuristic',
      confidence: 0.5,
      result: {
        title: sourceContent.title || null,
        shortSummary: this.shortSummary(sourceContent.content || ''),
        visualSummary: this.localSummary(sourceContent),
        ocrText: '',
        asrTranscript: this.shortSummary(sourceContent.content || ''),
        keywords: this.extractKeywords(sourceContent),
        scenes: [] as string[],
        speechAnalysis: {
          language: 'unknown',
          emotion: 'unknown',
          audioSummary: this.shortSummary(sourceContent.content || ''),
          highlights: [] as string[],
          tone: 'unknown',
          insights: [] as string[],
        },
        semanticAnalysis: {
          summary: this.shortSummary(sourceContent.content || ''),
          highlights: [] as string[],
          tone: 'unknown',
          keywords: this.extractKeywords(sourceContent),
          insights: [] as string[],
        },
        fallbackReason: reason,
      },
    };
  }

  private localSummary(sourceContent: SourceContentAnalysisInput) {
    const title = sourceContent.title || '无标题';
    const content = this.shortSummary(sourceContent.content || '');
    if (!content) {
      return `素材「${title}」缺少正文，建议补充可验证的场景细节。`;
    }
    return `素材「${title}」核心表达为：${content}`;
  }

  private shortSummary(content: string) {
    return content.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private extractKeywords(sourceContent: SourceContentAnalysisInput) {
    const text = `${sourceContent.title || ''} ${sourceContent.content || ''}`;
    const keywords = text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 8);
    return Array.from(new Set(keywords));
  }

  private async toDataUrl(filePath: string) {
    const file = await fs.readFile(filePath);
    const extension = extname(basename(filePath)).toLowerCase();
    const mimeByExt: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
    };
    const mime = mimeByExt[extension] || 'application/octet-stream';
    return `data:${mime};base64,${file.toString('base64')}`;
  }

  private async fetchRaw(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 400)}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit, timeoutMs: number) {
    const response = await this.fetchRaw(url, init, timeoutMs);
    const payload = (await response.json()) as T;
    return payload;
  }

  private runCommand(command: string, args: string[], timeoutMs = 30_000) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
      });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} timeout`));
      }, timeoutMs);

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `${command} exit ${code}`));
      });
    });
  }
}
