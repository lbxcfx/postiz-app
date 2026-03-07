import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
  Body,
  Sse,
  Res,
  Header,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import {
  MediaCrawlerLoginType,
  MediaCrawlerPlatform,
  MediaCrawlerService,
} from '@gitroom/nestjs-libraries/materials/materials.crawler.service';
import { MaterialsEventsService } from '@gitroom/nestjs-libraries/materials/materials.events.service';
import { MaterialsQueueService } from '@gitroom/nestjs-libraries/materials/materials.queue.service';
import {
  MaterialsService,
  MaterialsSearchQuery,
} from '@gitroom/nestjs-libraries/materials/materials.service';
import { MaterialsAnalysisService } from '@gitroom/nestjs-libraries/materials/materials.analysis.service';
import { MaterialsAnalysisQueueService } from '@gitroom/nestjs-libraries/materials/materials.analysis.queue.service';

interface MaterialsSearchRequest {
  platform: MediaCrawlerPlatform;
  keywords: string;
  startPage?: number;
  pageLimit?: number;
  forceCrawl?: boolean;
  incremental?: boolean;
}

interface MaterialAnalysisTriggerRequest {
  item?: {
    platform?: string;
    externalId?: string;
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
  force?: boolean;
}

@ApiTags('Materials')
@Controller('/materials')
export class MaterialsController {
  private readonly logger = new Logger(MaterialsController.name);

  constructor(
    private readonly queue: MaterialsQueueService,
    private readonly events: MaterialsEventsService,
    private readonly crawler: MediaCrawlerService,
    private readonly materials: MaterialsService,
    private readonly materialsAnalysis: MaterialsAnalysisService,
    private readonly materialsAnalysisQueue: MaterialsAnalysisQueueService
  ) { }

  @Post('/search')
  async search(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MaterialsSearchRequest
  ) {
    if (!body?.platform) {
      throw new BadRequestException('platform is required');
    }
    if (!body?.keywords) {
      throw new BadRequestException('keywords is required');
    }

    const startPage = body.startPage ?? 1;
    const query: MaterialsSearchQuery = {
      orgId: org.id,
      platform: body.platform,
      keywords: body.keywords,
      startPage,
      pageLimit: body.pageLimit,
    };
    const queryHash = this.materials.buildQueryHash(query);
    const incremental = Boolean(body.forceCrawl || body.incremental);
    const { historyResult, cachedAt } = await this.resolveSearchHistory(
      query,
      queryHash
    );

    if (!incremental && historyResult?.count) {
      return {
        jobId: null as string | null,
        state: 'succeeded',
        cachedResults: this.transformLocalPaths(historyResult.data),
        cachedAt: cachedAt || new Date().toISOString(),
        resultPath: historyResult.resultPath,
        count: historyResult.count,
        preview: this.transformLocalPaths(historyResult.preview),
        cacheHit: true,
        incremental: false,
      };
    }

    const jobId = `job_${uuidv4()}`;
    await this.queue.enqueueJob(jobId, {
      orgId: org.id,
      platform: body.platform,
      keywords: body.keywords,
      startPage,
      pageLimit: body.pageLimit,
      queryHash,
    });

    return {
      jobId,
      state: 'queued',
      cachedResults: [] as unknown[],
      cachedAt: null as string | null,
      cacheHit: false,
      historyResults: historyResult
        ? this.transformLocalPaths(historyResult.data)
        : null,
      historyCount: historyResult?.count ?? 0,
      historyPreview: historyResult
        ? this.transformLocalPaths(historyResult.preview)
        : null,
      incremental,
    };
  }

  private async resolveSearchHistory(
    query: MaterialsSearchQuery,
    queryHash: string
  ) {
    let historyResult = await this.materials.resolveKeywordResults({
      platform: query.platform,
      keywords: query.keywords,
      includeHistory: true,
    });
    let cachedAt: string | null = null;

    if (!historyResult) {
      const cached = await this.materials.getCachedResult(query);
      if (cached?.resultPath) {
        if (!this.materials.isPreferredResultPath(cached.resultPath)) {
          await this.materials.clearCachedResult(queryHash);
        } else {
          try {
            const cachedResults = await this.crawler.readFile(
              cached.resultPath,
              true,
              this.materials.getResultsLimit()
            );
            if (this.isCommentPayload(cachedResults)) {
              await this.materials.clearCachedResult(queryHash);
            } else {
              const normalized = this.normalizeResultsPayload(cachedResults);
              const preview = Array.isArray(cached.preview)
                ? cached.preview
                : normalized.data.slice(0, 5);
              historyResult = {
                resultPath: cached.resultPath,
                count: normalized.total,
                preview,
                data: normalized,
                sourcePaths: [cached.resultPath],
              };
              cachedAt = cached.cachedAt || null;
            }
          } catch {
            // Fallback to enqueue when cache is no longer valid.
          }
        }
      }
    }

    return { historyResult, cachedAt };
  }

  private normalizeResultsPayload(payload: unknown) {
    if (Array.isArray(payload)) {
      return {
        data: payload,
        total: payload.length,
      };
    }
    if (
      payload &&
      typeof payload === 'object' &&
      Array.isArray((payload as { data?: unknown[] }).data)
    ) {
      const list = (payload as { data: unknown[] }).data;
      const totalCandidate = Number(
        (payload as { total?: number | string }).total
      );
      return {
        data: list,
        total: Number.isFinite(totalCandidate) ? totalCandidate : list.length,
      };
    }
    return {
      data: [] as unknown[],
      total: 0,
    };
  }

  @Get('/job-status')
  async jobStatus(@Query('jobId') jobId: string) {
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    const status = await this.queue.getJobStatus(jobId);
    if (!status) {
      throw new NotFoundException('Job not found');
    }
    return status;
  }

  @Post('/stop')
  async stopJob(@Body() body: { jobId?: string }) {
    const jobId = String(body?.jobId || '').trim();
    if (!jobId) {
      await this.crawler.stopCrawl();
      return { stopped: true, state: 'stopping' };
    }
    const result = await this.queue.stopJob(jobId);
    if (!result.stopped) {
      throw new NotFoundException('Job not found');
    }
    try {
      await this.crawler.stopCrawl();
    } catch {
      // Ignore crawler stop errors when queue-level stop has already been requested.
    }
    return {
      jobId,
      ...result,
      message: 'Stop requested',
    };
  }

  @Get('/results')
  async results(@Query('jobId') jobId: string) {
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }

    const status = await this.queue.getJobStatus(jobId);
    if (!status) {
      throw new NotFoundException('Job not found');
    }
    const jobData = await this.queue.getJobData(jobId);
    if (jobData && jobData.crawler_type !== 'login') {
      const resolved = await this.materials.resolveKeywordResults({
        platform: jobData.platform,
        keywords: jobData.keywords,
        startedAt: jobData.startedAt ? new Date(jobData.startedAt) : undefined,
        includeHistory: true,
      });
      if (resolved) {
        return {
          jobId,
          state: status.state,
          resultPath: resolved.resultPath,
          count: resolved.count,
          preview: this.transformLocalPaths(resolved.preview),
          data: this.transformLocalPaths(resolved.data),
          partial: status.state !== 'succeeded',
        };
      }
    }

    if (status.state !== 'succeeded') {
      return { jobId, state: status.state, data: null as unknown | null };
    }

    const result = await this.queue.getJobResult(jobId);
    if (!result?.resultPath) {
      return { jobId, state: status.state, data: null as unknown | null };
    }

    const data = await this.crawler.readFile(
      result.resultPath,
      true,
      this.materials.getResultsLimit()
    );
    return {
      jobId,
      state: status.state,
      resultPath: result.resultPath,
      count: result.count,
      preview: this.transformLocalPaths(result.preview),
      data: this.transformLocalPaths(data),
    };
  }

  @Get('/analysis')
  async getAnalysis(
    @GetOrgFromRequest() org: Organization,
    @Query('platform') platform: string,
    @Query('externalId') externalId: string
  ) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    const normalizedExternalId = String(externalId || '').trim();
    if (!normalizedPlatform || !normalizedExternalId) {
      throw new BadRequestException('platform and externalId are required');
    }
    const result = await this.materialsAnalysis.getLatestAnalysis(
      org.id,
      normalizedPlatform,
      normalizedExternalId
    );
    if (!result) {
      return { found: false, data: null };
    }
    return { found: true, data: result };
  }

  @Post('/analysis/trigger')
  async triggerAnalysis(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MaterialAnalysisTriggerRequest
  ) {
    const item = body?.item;
    if (!item) {
      throw new BadRequestException('item is required');
    }
    const platform = String(item.platform || '').trim().toLowerCase();
    const externalId = String(item.externalId || '').trim();
    if (!platform || !externalId) {
      throw new BadRequestException('item.platform and item.externalId are required');
    }

    const force = Boolean(body?.force);
    if (!force) {
      const existing = await this.materialsAnalysis.getLatestAnalysis(org.id, platform, externalId);
      if (existing) {
        return {
          found: true,
          source: 'cache',
          data: existing,
        };
      }
    }

    const queued = await this.materialsAnalysisQueue.enqueueJob({
      orgId: org.id,
      force,
      item: {
        platform,
        externalId,
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
    });
    return {
      accepted: true,
      jobId: queued.jobId,
      reused: queued.reused,
      state: queued.reused ? 'running' : 'queued',
    };
  }

  @Get('/analysis/job-status')
  async getAnalysisJobStatus(
    @GetOrgFromRequest() org: Organization,
    @Query('jobId') jobId: string
  ) {
    const normalizedJobId = String(jobId || '').trim();
    if (!normalizedJobId) {
      throw new BadRequestException('jobId is required');
    }
    const status = await this.materialsAnalysisQueue.getJobStatus(
      normalizedJobId,
      org.id
    );
    return status;
  }

  @Get('/file/:jobId/:filename')
  @Header('Cache-Control', 'public, max-age=31536000')
  async getFile(
    @Param('jobId') jobId: string,
    @Param('filename') filename: string,
    @Res() res: Response
  ) {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new BadRequestException('Invalid filename');
    }
    const filePath = path.join(process.cwd(), 'uploads', 'materials', jobId, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('File not found');
    }
    res.sendFile(filePath);
  }

  private transformLocalPaths(data: any) {
    if (!data) return data;
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    const baseUrl = `${backendUrl}/materials/file/`;

    const traverse = (obj: any) => {
      if (!obj) return;
      if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else if (typeof obj === 'object') {
        for (const key in obj) {
          if (typeof obj[key] === 'string' && obj[key].startsWith('local:')) {
            const relative = obj[key].substring(6);
            obj[key] = baseUrl + relative;
          } else {
            traverse(obj[key]);
          }
        }
      }
    };

    const copy = JSON.parse(JSON.stringify(data));
    traverse(copy);
    return copy;
  }

  @Get('/login-status')
  async loginStatus(
    @Query('platform') platform: string = 'xhs'
  ) {
    const validPlatforms: MediaCrawlerPlatform[] = ['xhs', 'dy'];
    const p = validPlatforms.includes(platform as MediaCrawlerPlatform)
      ? (platform as MediaCrawlerPlatform)
      : 'xhs';
    return this.crawler.checkLoginStatus(p);
  }

  @Post('/enrich-profiles')
  async enrichProfiles(
    @Body() body: { platform?: string; user_ids: string[] }
  ) {
    const platform = (body.platform || 'xhs') as MediaCrawlerPlatform;
    if (!body.user_ids?.length) {
      return { platform, profiles: [], fetched: 0, failed: 0 };
    }
    return this.crawler.getUserProfiles(platform, body.user_ids);
  }

  @Post('/trigger-login')
  async triggerLogin(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      platform?: string;
      loginType?: MediaCrawlerLoginType;
      loginPhone?: string;
    }
  ) {
    let payload: {
      platform?: string;
      loginType?: MediaCrawlerLoginType;
      loginPhone?: string;
    } = body || {};
    if (typeof (body as unknown) === 'string') {
      try {
        payload = JSON.parse(body as unknown as string);
      } catch {
        payload = {};
      }
    }

    const platform = (payload.platform || 'xhs') as MediaCrawlerPlatform;
    const inferredPhone = this.normalizeLoginPhone(payload.loginPhone);
    const loginType: MediaCrawlerLoginType =
      payload.loginType === 'phone' || (!!inferredPhone && !payload.loginType)
        ? 'phone'
        : 'qrcode';
    const loginPhone = inferredPhone;
    if (loginType === 'phone' && !loginPhone) {
      throw new BadRequestException('loginPhone is required for phone login');
    }
    const jobId = `login_${uuidv4()}`;

    // Start a specialized login job
    await this.queue.enqueueJob(jobId, {
      orgId: org.id,
      platform,
      crawler_type: 'login', // Important: trigger login sequence
      keywords: '',
      startPage: 1,
      pageLimit: 1,
      queryHash: `login_${platform}_${Date.now()}`,
      loginType,
      loginPhone: loginType === 'phone' ? loginPhone : undefined,
    });

    return { jobId, state: 'queued', loginType };
  }

  @Post('/submit-sms-code')
  async submitSmsCode(
    @Body()
    body: {
      platform?: string;
      loginPhone?: string;
      smsCode?: string;
      jobId?: string;
    }
  ) {
    let payload: {
      platform?: string;
      loginPhone?: string;
      smsCode?: string;
      jobId?: string;
    } = body || {};
    if (typeof (body as unknown) === 'string') {
      try {
        payload = JSON.parse(body as unknown as string);
      } catch {
        payload = {};
      }
    }

    const platform = (payload.platform || 'xhs') as MediaCrawlerPlatform;
    const loginPhone = this.normalizeLoginPhone(payload.loginPhone);
    const smsCode = String(payload.smsCode || '').trim();
    if (!loginPhone) {
      throw new BadRequestException('loginPhone is required');
    }
    if (!smsCode) {
      throw new BadRequestException('smsCode is required');
    }
    if (payload.jobId) {
      const jobData = await this.queue.getJobData(payload.jobId);
      if (!jobData) {
        throw new BadRequestException('login job not found');
      }
      if (jobData.crawler_type === 'login' && jobData.loginType !== 'phone') {
        throw new BadRequestException('当前登录任务不是手机号模式，请先点击获取验证码');
      }
    }

    return this.crawler.submitSmsCode({
      platform,
      login_phone: loginPhone,
      sms_code: smsCode,
      client_job_id: payload.jobId,
    });
  }

  @Get('/login-qrcode')
  async loginQrcode(@Query('jobId') jobId: string) {
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }

    const logs = await this.crawler.getLogs(400);
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const log = logs[i];
      if (log.client_job_id && log.client_job_id !== jobId) {
        continue;
      }
      const qr = this.extractQrBase64FromMessage(log.message);
      if (qr) {
        return {
          jobId,
          found: true,
          base64_image: qr,
          timestamp: log.timestamp,
        };
      }
    }

    return {
      jobId,
      found: false,
      base64_image: null as string | null,
    };
  }

  @Sse('/events')
  eventsStream(@Query('jobId') jobId: string) {
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    return this.events.subscribe(jobId);
  }

  private isCommentPayload(payload: unknown) {
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown[] })?.data)
        ? (payload as { data?: unknown[] }).data
        : [];
    const sample = items.find(
      (item) => item && typeof item === 'object'
    ) as Record<string, unknown> | undefined;
    if (!sample) {
      return false;
    }
    return 'comment_id' in sample;
  }

  private extractQrBase64FromMessage(message: string) {
    const markers = ['QRCODE_BASE64:', 'BROWSER_SCREENSHOT_BASE64:'];
    for (const marker of markers) {
      const index = message.indexOf(marker);
      if (index < 0) {
        continue;
      }
      const raw = message.slice(index + marker.length).trim();
      if (!raw) {
        continue;
      }
      if (raw.startsWith('data:image')) {
        const parts = raw.split(',', 2);
        return parts[1] || raw;
      }
      return raw;
    }
    return null;
  }

  private normalizeLoginPhone(phone?: string) {
    const raw = String(phone || '').trim();
    if (!raw) {
      return '';
    }
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      return raw;
    }
    if (digits.length === 13 && digits.startsWith('86')) {
      return digits.slice(2);
    }
    if (digits.length > 11) {
      return digits.slice(-11);
    }
    return digits;
  }

  /**
   * Image proxy endpoint to bypass CDN anti-hotlinking protection.
   * Fetches images with proper Referer headers and streams them to frontend.
   */
  @Get('/image-proxy')
  @Header('Cache-Control', 'public, max-age=86400')
  async imageProxy(
    @Query('url') url: string,
    @Query('platform') platform: string = 'xhs',
    @Res() res: Response
  ) {
    if (!url) {
      throw new BadRequestException('url is required');
    }

    // Decode the URL (it should be encoded when passed as query param)
    const decodedUrl = decodeURIComponent(url);

    // Validate URL - only allow certain CDN domains for security
    const allowedDomains = [
      'xhscdn.com',
      'xiaohongshu.com',
      'sns-webpic-qc.xhscdn.com',
      'sns-img-qc.xhscdn.com',
      'sns-video-qc.xhscdn.com',
      'ci.xiaohongshu.com',
      'douyinpic.com',
      'douyinvod.com',
      'byteimg.com',
      'pstatp.com',
    ];

    try {
      const parsedUrl = new URL(decodedUrl);
      const isAllowed = allowedDomains.some(domain =>
        parsedUrl.hostname.endsWith(domain)
      );

      if (!isAllowed) {
        throw new BadRequestException('Domain not allowed');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Invalid URL');
    }

    // Set Referer based on platform
    const refererMap: Record<string, string> = {
      xhs: 'https://www.xiaohongshu.com/',
      dy: 'https://www.douyin.com/',
      bili: 'https://www.bilibili.com/',
    };
    const referer = refererMap[platform] || refererMap.xhs;

    try {
      const cacheDir = path.join(process.cwd(), 'uploads', 'materials-cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const hash = createHash('md5').update(decodedUrl).digest('hex');
      const guessedExt = this.getExtensionFromUrl(decodedUrl);
      const guessedCachePath = path.join(cacheDir, `${hash}${guessedExt || '.bin'}`);
      if (fs.existsSync(guessedCachePath)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.sendFile(guessedCachePath);
      }

      const response = await fetch(decodedUrl, {
        headers: {
          'Referer': referer,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-site': 'cross-site',
        },
      });

      if (!response.ok) {
        throw new NotFoundException(`Image not found: ${response.status}`);
      }

      // Get content type from response
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const extFromType = this.getExtensionFromContentType(contentType);
      const finalCachePath = path.join(
        cacheDir,
        `${hash}${extFromType || guessedExt || '.bin'}`
      );

      const buffer = await response.arrayBuffer();
      const payload = Buffer.from(buffer);
      try {
        if (!fs.existsSync(finalCachePath)) {
          fs.writeFileSync(finalCachePath, payload);
        }
      } catch (cacheError) {
        this.logger.warn(
          `Failed to persist materials media cache for ${decodedUrl}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`
        );
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.send(payload);
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) {
        throw e;
      }
      throw new NotFoundException('Failed to fetch image');
    }
  }

  private getExtensionFromUrl(rawUrl: string) {
    try {
      const parsed = new URL(rawUrl);
      const ext = path.extname(parsed.pathname || '').toLowerCase();
      if (/^\.[a-z0-9]{1,6}$/.test(ext)) {
        return ext;
      }
      return '';
    } catch {
      return '';
    }
  }

  private getExtensionFromContentType(contentType: string) {
    const lowered = String(contentType || '').toLowerCase();
    if (!lowered) return '';
    if (lowered.includes('video/mp4')) return '.mp4';
    if (lowered.includes('video/webm')) return '.webm';
    if (lowered.includes('video/quicktime')) return '.mov';
    if (lowered.includes('image/jpeg')) return '.jpg';
    if (lowered.includes('image/png')) return '.png';
    if (lowered.includes('image/webp')) return '.webp';
    if (lowered.includes('image/gif')) return '.gif';
    return '';
  }
}
