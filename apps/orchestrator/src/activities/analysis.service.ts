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
      const vision = await this.runVisionAndOcrAsr(sourceContent, frames);

      return {
        sourceContentId: sourceContent.sourceContentId,
        type: 'video_analysis',
        modelUsed: vision.modelUsed,
        confidence: vision.confidence,
        result: {
          title: sourceContent.title || null,
          shortSummary: this.shortSummary(sourceContent.content || ''),
          video: {
            source: videoAsset.url,
            frameCount: frames.length,
            ffmpegAvailable: this.ffmpegAvailable === true,
          },
          ocrText: vision.ocrText,
          asrTranscript: vision.asrTranscript,
          visualSummary: vision.summary,
          keywords: vision.keywords,
          scenes: vision.scenes,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'analysis failed';
      this.logger.warn(`analyzeOne fallback: ${message}`);
      return this.createTextFallback(sourceContent, message);
    }
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
      '3',
      outputPattern,
    ]);

    const files = await fs.readdir(workspace);
    return files
      .filter((name) => /^frame-\d+\.jpg$/i.test(name))
      .map((name) => join(workspace, name))
      .sort();
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

  private async runVisionAndOcrAsr(
    sourceContent: SourceContentAnalysisInput,
    frames: string[]
  ): Promise<{
    modelUsed: string;
    confidence: number;
    summary: string;
    keywords: string[];
    ocrText: string;
    asrTranscript: string;
    scenes: string[];
  }> {
    const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
    if (!apiKey || frames.length === 0) {
      return {
        modelUsed: 'local-heuristic',
        confidence: 0.55,
        summary: this.localSummary(sourceContent),
        keywords: this.extractKeywords(sourceContent),
        ocrText: '',
        asrTranscript: this.shortSummary(sourceContent.content || ''),
        scenes: [],
      };
    }

    const baseURL = (
      process.env.QWEN_BASE_URL ||
      process.env.QWEN_API_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/$/, '');

    const endpoint = `${baseURL}/chat/completions`;
    const model = process.env.QWEN_VL_MODEL || 'qwen-vl-max-latest';
    const frameContent = await Promise.all(
      frames.slice(0, 2).map(async (frame) => ({
        type: 'image_url',
        image_url: {
          url: await this.toDataUrl(frame),
        },
      }))
    );

    const prompt = [
      '请基于视频帧与文本信息，输出严格 JSON：',
      '{"summary":"", "keywords":[""], "ocrText":"", "asrTranscript":"", "scenes":[""]}',
      `标题：${sourceContent.title || ''}`,
      `正文：${sourceContent.content || ''}`,
    ].join('\n');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: '你是内容分析助手，必须返回 JSON，不要输出额外文本。',
          },
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, ...frameContent],
          },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      throw new Error(`vl api failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const rawContent = payload.choices?.[0]?.message?.content;
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.map((item) => item?.text || '').join('\n')
          : '';
    const parsed = this.parseJsonPayload(text);

    return {
      modelUsed: model,
      confidence: 0.82,
      summary: typeof parsed.summary === 'string' ? parsed.summary : this.localSummary(sourceContent),
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((item): item is string => typeof item === 'string').slice(0, 8)
        : this.extractKeywords(sourceContent),
      ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
      asrTranscript:
        typeof parsed.asrTranscript === 'string'
          ? parsed.asrTranscript
          : this.shortSummary(sourceContent.content || ''),
      scenes: Array.isArray(parsed.scenes)
        ? parsed.scenes.filter((item): item is string => typeof item === 'string').slice(0, 6)
        : [],
    };
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
        scenes: [],
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
    const mime = extname(basename(filePath)).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${file.toString('base64')}`;
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
