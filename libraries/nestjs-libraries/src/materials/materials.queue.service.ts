import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  Job,
  JobsOptions,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
} from 'bullmq';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  MediaCrawlerLoginType,
  MediaCrawlerPlatform,
  MediaCrawlerService,
} from '@gitroom/nestjs-libraries/materials/materials.crawler.service';
import { MaterialsService } from '@gitroom/nestjs-libraries/materials/materials.service';
import {
  MaterialsEventPayload,
  MaterialsEventsService,
} from '@gitroom/nestjs-libraries/materials/materials.events.service';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const DEFAULT_QUEUE_NAME = 'materials';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5000;
const DEFAULT_STALLED_INTERVAL_MS = 30000;
const DEFAULT_MAX_STALLED_COUNT = 2;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 1;
const DEFAULT_PAGE_SIZE = 20;

export interface MaterialsJobData {
  orgId: string;
  platform: MediaCrawlerPlatform;
  crawler_type?: 'search' | 'detail' | 'creator' | 'login';
  keywords: string;
  startPage: number;
  pageLimit?: number;
  queryHash?: string;
  startedAt?: string;
  consumedPaths?: string[];
  loginType?: MediaCrawlerLoginType;
  loginPhone?: string;
}

export interface MaterialsJobResult {
  resultPath?: string;
  count?: number;
  preview?: unknown;
}

export interface MaterialsJobStatus {
  jobId: string;
  state: string;
  progress: number;
  message?: string;
  error?: string | null;
}

@Injectable()
export class MaterialsQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaterialsQueueService.name);
  private queue: Queue<MaterialsJobData, MaterialsJobResult> | null = null;
  private worker: Worker<MaterialsJobData, MaterialsJobResult> | null = null;
  private events: QueueEvents | null = null;
  private dlq: Queue<MaterialsJobData, MaterialsJobResult> | null = null;
  private readonly enabled = Boolean(process.env.REDIS_URL);
  private readonly queueName: string;
  private readonly dlqName: string;
  private readonly logsForwardingEnabled: boolean;
  private readonly cancelKeyPrefix = 'materials:cancel:';

  constructor(
    private readonly crawler: MediaCrawlerService,
    private readonly materials: MaterialsService,
    private readonly eventsService: MaterialsEventsService
  ) {
    this.queueName = process.env.MATERIALS_QUEUE_NAME || DEFAULT_QUEUE_NAME;
    this.dlqName =
      process.env.MATERIALS_DLQ_NAME || `${this.queueName}-dlq`;
    this.logsForwardingEnabled =
      process.env.ENABLE_CRAWLER_LOGS_FORWARDING !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('REDIS_URL is not set; materials queue is disabled.');
      return;
    }

    const connection = ioRedis;
    const attempts = this.parseNumber(
      process.env.MATERIALS_JOB_ATTEMPTS,
      DEFAULT_ATTEMPTS
    );
    const backoffMs = this.parseNumber(
      process.env.MATERIALS_JOB_BACKOFF_MS,
      DEFAULT_BACKOFF_MS
    );
    const stalledIntervalMs = this.parseNumber(
      process.env.MATERIALS_JOB_STALLED_INTERVAL_MS,
      DEFAULT_STALLED_INTERVAL_MS
    );
    const maxStalledCount = this.parseNumber(
      process.env.MATERIALS_JOB_MAX_STALLED_COUNT,
      DEFAULT_MAX_STALLED_COUNT
    );

    const jobOptions: JobsOptions = {
      attempts,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    };

    this.queue = new Queue(this.queueName, {
      connection,
      defaultJobOptions: jobOptions,
    });
    this.dlq = new Queue(this.dlqName, { connection });
    this.events = new QueueEvents(this.queueName, { connection });
    this.worker = new Worker(
      this.queueName,
      (job) => this.handleJob(job),
      {
        connection,
        concurrency: 1,
        stalledInterval: stalledIntervalMs,
        maxStalledCount,
      }
    );

    this.worker.on('failed', async (job, error) => {
      if (!job) {
        return;
      }
      const jobId = this.getJobId(job);
      const isManualStop = (error?.message || '').includes('任务已手动停止');
      await ioRedis.del(this.cancelKeyPrefix + jobId);
      const payload: MaterialsEventPayload = {
        type: 'error',
        state: 'failed',
        message: isManualStop ? '任务已手动停止' : error?.message || 'Crawler failed',
      };
      this.emitEvent(jobId, payload);
      if (!isManualStop) {
        await this.dlq?.add('dead', { ...job.data }, jobOptions);
      }
    });

    this.worker.on('completed', async (job) => {
      if (!job) {
        return;
      }
      await ioRedis.del(this.cancelKeyPrefix + this.getJobId(job));
    });

    await this.cleanupZombieCrawler();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.events?.close();
    await this.queue?.close();
    await this.dlq?.close();
  }

  async enqueueJob(jobId: string, data: MaterialsJobData) {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    await ioRedis.del(this.cancelKeyPrefix + jobId);
    const job = await this.queue.add('crawl', data, { jobId });
    this.emitEvent(job.id ?? jobId, {
      type: 'status',
      state: 'queued',
      progress: 0,
      message: 'Queued for crawling',
    });
    return job;
  }

  async addSearchJob(orgId: string, params: Omit<MaterialsJobData, 'orgId'>) {
    const jobId = uuidv4();
    const data: MaterialsJobData = {
      ...params,
      orgId,
    };
    return this.enqueueJob(jobId, data);
  }

  async getJobStatus(jobId: string): Promise<MaterialsJobStatus | null> {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }
    const state = await job.getState();
    const { progress, message } = this.extractProgress(job.progress);
    const error = job.failedReason || null;
    return {
      jobId,
      state: this.mapQueueState(state, progress),
      progress,
      message,
      error,
    };
  }

  async getJobResult(jobId: string): Promise<MaterialsJobResult | null> {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }
    const state = await job.getState();
    if (state !== 'completed') {
      return null;
    }
    return (job.returnvalue as MaterialsJobResult) ?? null;
  }

  async getJobData(jobId: string): Promise<MaterialsJobData | null> {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    const job = await this.queue.getJob(jobId);
    return job?.data ?? null;
  }

  async getJob(jobId: string) {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    return this.queue.getJob(jobId);
  }

  async stopJob(jobId: string) {
    this.ensureEnabled();
    if (!this.queue) {
      throw new Error('Materials queue is not initialized.');
    }
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return { stopped: false, state: 'missing' };
    }
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      await ioRedis.del(this.cancelKeyPrefix + jobId);
      this.emitEvent(jobId, {
        type: 'status',
        state: 'failed',
        progress: 0,
        message: '任务已手动停止',
      });
      return { stopped: true, state: 'removed' };
    }
    await ioRedis.set(this.cancelKeyPrefix + jobId, '1', 'EX', 60 * 60);
    this.emitEvent(jobId, {
      type: 'status',
      state: 'running',
      progress: 0,
      message: '正在停止任务...',
    });
    return { stopped: true, state };
  }

  private async handleJob(job: Job<MaterialsJobData, MaterialsJobResult>) {
    const startedAt = new Date();
    await job.updateData({
      ...job.data,
      startedAt: startedAt.toISOString(),
      consumedPaths: job.data.consumedPaths ?? [],
    });

    await job.updateProgress({
      state: 'running',
      progress: 0.05,
      message: 'Checking login status...',
    });
    const jobId = this.getJobId(job);
    await this.ensureCrawlerIdle(jobId);

    this.emitEvent(jobId, {
      type: 'status',
      state: 'running',
      progress: 0.05,
      message: 'Checking login status...',
    });

    const isLoginJob = job.data.crawler_type === 'login';
    const requestedLoginType = job.data.loginType === 'phone' ? 'phone' : 'qrcode';
    if (isLoginJob && requestedLoginType === 'phone' && !job.data.loginPhone) {
      throw new Error('Phone login requires login phone number');
    }

    // Check login status to determine headless mode.
    // Default is still conservative headless in WSL/systemd, but phone login can
    // be explicitly forced to headed because SMS/captcha often requires interaction.
    const loginStatus = await this.crawler.checkLoginStatus(job.data.platform);
    const useHeadless = loginStatus.has_valid_login;
    const allowHeadedBrowser =
      process.env.MATERIALS_ALLOW_HEADED_BROWSER === '1';
    const forceHeadedPhoneLogin =
      isLoginJob &&
      requestedLoginType === 'phone' &&
      process.env.MATERIALS_PHONE_LOGIN_HEADED === '1';
    const runHeadless = forceHeadedPhoneLogin
      ? false
      : useHeadless || !allowHeadedBrowser;

    this.logger.log(
      `[handleJob] Platform: ${job.data.platform}, ` +
      `hasValidLogin: ${loginStatus.has_valid_login}, ` +
      `recommendation: ${loginStatus.recommendation}, ` +
      `message: ${loginStatus.message}`
    );

    this.emitEvent(jobId, {
      type: 'status',
      state: 'running',
      progress: 0.1,
      message:
        useHeadless
          ? 'Valid login found, using headless mode'
          : forceHeadedPhoneLogin
            ? 'No valid login, forcing headed browser for phone verification'
          : runHeadless
            ? 'No valid login, using headless QR mode'
            : 'No valid login, browser window will open for QR code login',
    });
    const normalizedKeywords = (job.data.keywords || '').trim();
    const loginBootstrapKeyword =
      process.env.MATERIALS_LOGIN_BOOTSTRAP_KEYWORD || '小红书';
    const keywords = isLoginJob
      ? normalizedKeywords || loginBootstrapKeyword
      : normalizedKeywords;
    const enableComments = process.env.MATERIALS_ENABLE_COMMENTS === '1';
    const enableSubComments =
      enableComments && process.env.MATERIALS_ENABLE_SUB_COMMENTS === '1';

    await this.crawler.startCrawl({
      platform: job.data.platform,
      crawler_type: 'search',
      keywords,
      client_job_id: jobId || undefined,
      login_type: requestedLoginType,
      login_phone: requestedLoginType === 'phone' ? job.data.loginPhone : undefined,
      save_option: 'json',
      start_page: job.data.startPage,
      crawl_count: isLoginJob ? 1 : this.getCrawlCount(job.data),
      enable_comments: enableComments,
      enable_sub_comments: enableSubComments,
      headless: runHeadless, // Intelligent headless mode switching
    });

    const result = await this.monitorCrawler(job, startedAt);
    return result;
  }

  private async ensureCrawlerIdle(jobId: string) {
    const status = await this.crawler.getStatus();
    if (status.status !== 'running' && status.status !== 'stopping') {
      return;
    }

    this.logger.warn(
      `[ensureCrawlerIdle] Existing crawler status=${status.status}, stopping before job ${jobId}`
    );
    this.emitEvent(jobId, {
      type: 'status',
      state: 'running',
      progress: 0.03,
      message: 'Detected existing crawler task, stopping it first...',
    });

    await this.crawler.stopCrawl();
    const timeoutMs = this.parseNumber(
      process.env.MATERIALS_CRAWLER_STOP_TIMEOUT_MS,
      30000
    );
    const pollMs = 500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const current = await this.crawler.getStatus();
      if (current.status === 'idle' || current.status === 'error') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error('Timed out while stopping existing crawler process');
  }

  private async monitorCrawler(
    job: Job<MaterialsJobData, MaterialsJobResult>,
    startedAt: Date
  ): Promise<MaterialsJobResult> {
    const timeoutMs = this.getTimeoutMs();
    const pollIntervalMs = this.getPollIntervalMs();
    let lastLogId = 0;
    let sawRunning = false;
    let sawLoginSuccessLog = false;
    let loginSuccessDetectedAtMs: number | null = null;
    let stopRequestedAfterLoginSuccess = false;
    const startedAtMs = Date.now();
    const isLoginJob = job.data.crawler_type === 'login';
    const loginSuccessStopGraceMs = this.parseNumber(
      process.env.MATERIALS_LOGIN_SUCCESS_STOP_GRACE_MS,
      12000
    );

    while (true) {
      const jobId = this.getJobId(job);
      if (await this.isJobCancelled(jobId)) {
        try {
          await this.crawler.stopCrawl();
        } catch (error) {
          // Ignore stop errors while cancellation is in progress.
        }
        throw new UnrecoverableError('任务已手动停止');
      }
      if (Date.now() - startedAtMs > timeoutMs) {
        throw new Error('Crawler timed out');
      }

      const status = await this.crawler.getStatus();
      const logState = await this.emitLogs(jobId, lastLogId, job.data.platform);
      lastLogId = logState.lastLogId;
      if (isLoginJob && logState.loginSuccess) {
        sawLoginSuccessLog = true;
        if (!loginSuccessDetectedAtMs) {
          loginSuccessDetectedAtMs = Date.now();
        }
      }

      if (status.status === 'running') {
        sawRunning = true;
      }

      if (
        isLoginJob &&
        sawLoginSuccessLog &&
        loginSuccessDetectedAtMs !== null &&
        Date.now() - loginSuccessDetectedAtMs >= loginSuccessStopGraceMs &&
        !stopRequestedAfterLoginSuccess
      ) {
        this.emitEvent(jobId, {
          type: 'status',
          state: 'running',
          progress: 0.92,
          message: '登录已完成，正在结束登录任务...',
        });
        try {
          await this.crawler.stopCrawl();
        } catch {
          // Ignore stop errors here and continue polling status.
        }
        stopRequestedAfterLoginSuccess = true;
      }

      if (status.status === 'idle') {
        if (!sawRunning) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        break;
      }

      if (status.status === 'error') {
        throw new Error(status.error_message || 'Crawler failed');
      }

      const normalizedState = this.mapCrawlerState(status.status);
      const progressValue = normalizedState === 'running' ? 0.5 : 0.9;
      await job.updateProgress({
        state: normalizedState,
        progress: progressValue,
        message: status.error_message || undefined,
      });

      this.emitEvent(jobId, {
        type: 'status',
        state: normalizedState,
        progress: progressValue,
        message: status.error_message || undefined,
      });

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (isLoginJob) {
      const verifyTimeoutMs = this.parseNumber(
        process.env.MATERIALS_LOGIN_VERIFY_TIMEOUT_MS,
        45000
      );
      const verifyPollMs = this.parseNumber(
        process.env.MATERIALS_LOGIN_VERIFY_POLL_INTERVAL_MS,
        1000
      );
      const verifyStartedAt = Date.now();
      let latestMessage = '';

      while (Date.now() - verifyStartedAt < verifyTimeoutMs) {
        const loginStatus = await this.crawler.checkLoginStatus(job.data.platform);
        latestMessage = loginStatus.message || '';
        if (loginStatus.has_valid_login) {
          this.emitEvent(this.getJobId(job), {
            type: 'login_success',
            platform: job.data.platform,
          });
          return { count: 0, preview: null };
        }
        await new Promise((resolve) => setTimeout(resolve, verifyPollMs));
      }

      throw new Error(
        latestMessage
          ? `Login did not complete: ${latestMessage}`
          : 'Login did not complete: still not logged in'
      );
    }

    let consumedPaths = job.data.consumedPaths ?? [];
    const resolveTimeoutMs = this.parseNumber(
      process.env.MATERIALS_RESULT_RESOLVE_TIMEOUT_MS,
      120000
    );
    const resolvePollMs = this.parseNumber(
      process.env.MATERIALS_RESULT_RESOLVE_POLL_INTERVAL_MS,
      3000
    );
    const resolveStartedAt = Date.now();
    let resolved:
      | {
        file: { path: string };
        data: unknown;
      }
      | null = null;
    let sawNonContent = false;

    while (Date.now() - resolveStartedAt < resolveTimeoutMs) {
      if (await this.isJobCancelled(this.getJobId(job))) {
        throw new UnrecoverableError('任务已手动停止');
      }
      resolved = await this.materials.resolveOutputForJob({
        jobId: this.getJobId(job),
        platform: job.data.platform,
        startedAt,
        consumedPaths,
      });

      if (!resolved) {
        await new Promise((resolve) => setTimeout(resolve, resolvePollMs));
        continue;
      }

      if (!this.isNonContentPayload(resolved.data, job.data.platform)) {
        break;
      }

      sawNonContent = true;
      consumedPaths = [...consumedPaths, resolved.file.path];
      await job.updateData({ ...job.data, consumedPaths });
      resolved = null;
      await new Promise((resolve) => setTimeout(resolve, resolvePollMs));
    }

    if (!resolved) {
      if (sawNonContent) {
        throw new Error(
          `No content output file found for job after ${Math.round(resolveTimeoutMs / 1000)}s`
        );
      }
      throw new Error(
        `No output file found for job after ${Math.round(resolveTimeoutMs / 1000)}s`
      );
    }

    await this.downloadAssets(resolved.file.path, this.getJobId(job));

    // Reload data after download updates
    if (fs.existsSync(resolved.file.path)) {
      resolved.data = JSON.parse(fs.readFileSync(resolved.file.path, 'utf-8'));
    }

    const { count, preview } = this.extractResultSummary(resolved.data);
    const updatedConsumed = [...consumedPaths, resolved.file.path];
    await job.updateData({ ...job.data, consumedPaths: updatedConsumed });

    this.emitEvent(this.getJobId(job), {
      type: 'result',
      count,
      preview,
    });

    await this.cacheResult(job, {
      resultPath: resolved.file.path,
      count,
      preview,
    });

    return {
      resultPath: resolved.file.path,
      count,
      preview,
    };
  }

  private async emitLogs(
    jobId: string,
    lastLogId: number,
    platform: MediaCrawlerPlatform
  ) {
    if (!this.logsForwardingEnabled) {
      return { lastLogId, loginSuccess: false };
    }
    if (!jobId) {
      return { lastLogId, loginSuccess: false };
    }
    const logs = await this.crawler.getLogs();
    const newLogs = logs.filter((log) => log.id > lastLogId);
    let sawLoginSuccess = false;
    for (const log of newLogs) {
      if (log.client_job_id && log.client_job_id !== jobId) {
        continue;
      }
      const qrCode = this.extractQrCode(log.message);
      if (qrCode) {
        this.emitEvent(jobId, {
          type: 'login_qrcode',
          platform,
          base64_image: qrCode,
          message: 'Scan the QR code to continue',
        });
        this.emitEvent(jobId, {
          type: 'status',
          state: 'login_required',
          progress: 0.2,
          message: 'Login required',
        });
        continue;
      }
      if (this.isSmsRequiredMessage(log.message)) {
        this.emitEvent(jobId, {
          type: 'sms_required',
          platform,
          message: '请输入短信验证码',
        });
      }
      if (this.isLoginSuccessMessage(log.message)) {
        sawLoginSuccess = true;
        this.emitEvent(jobId, { type: 'login_success', platform });
      }
      if (this.isFatalCrawlerLog(log.message)) {
        const fatalMessage = `Crawler startup failed: ${log.message}`;
        this.emitEvent(jobId, {
          type: 'error',
          state: 'failed',
          message: fatalMessage,
        });
        throw new Error(fatalMessage);
      }
      this.emitEvent(jobId, {
        type: 'log',
        level: log.level,
        message: log.message,
        timestamp: log.timestamp,
      });
    }
    if (newLogs.length > 0) {
      return {
        lastLogId: newLogs[newLogs.length - 1].id,
        loginSuccess: sawLoginSuccess,
      };
    }
    return { lastLogId, loginSuccess: sawLoginSuccess };
  }

  private async cleanupZombieCrawler() {
    try {
      const status = await this.crawler.getStatus();
      if (status.status === 'running' || status.status === 'stopping') {
        this.logger.warn('Detected running crawler on startup. Sending stop...');
        await this.crawler.stopCrawl();
      }
    } catch (error) {
      this.logger.warn('Unable to check MediaCrawler status on startup.');
    }
  }

  private mapCrawlerState(status: string) {
    switch (status) {
      case 'running':
      case 'stopping':
        return status;
      case 'idle':
        return 'succeeded';
      case 'error':
        return 'failed';
      default:
        return status;
    }
  }

  private mapQueueState(state: string, progress: number) {
    if (state === 'waiting' || state === 'delayed') {
      return 'queued';
    }
    if (state === 'active') {
      return 'running';
    }
    if (state === 'completed') {
      return 'succeeded';
    }
    if (state === 'failed') {
      return 'failed';
    }
    return state;
  }

  private extractProgress(progress: unknown) {
    if (typeof progress === 'number') {
      return { progress, message: undefined as string | undefined };
    }
    if (
      typeof progress === 'object' &&
      progress !== null &&
      'progress' in progress
    ) {
      const value = progress as { progress?: number; message?: string };
      return {
        progress: value.progress ?? 0,
        message: value.message,
      };
    }
    return { progress: 0, message: undefined as string | undefined };
  }

  private extractResultSummary(data: unknown) {
    if (data && typeof data === 'object' && 'data' in data) {
      const payload = data as { data?: unknown[]; total?: number };
      const list = Array.isArray(payload.data) ? payload.data : [];
      return {
        count: payload.total ?? list.length,
        preview: list.slice(0, 5),
      };
    }
    if (Array.isArray(data)) {
      return { count: data.length, preview: data.slice(0, 5) };
    }
    return { count: 0, preview: null };
  }

  private getCrawlCount(data: MaterialsJobData) {
    const pages =
      typeof data.pageLimit === 'number' && data.pageLimit > 0
        ? Math.floor(data.pageLimit)
        : DEFAULT_PAGE_LIMIT;
    const pageSize = this.getPageSize(data.platform);
    return pages * pageSize;
  }

  private getPageSize(platform: MediaCrawlerPlatform) {
    if (platform === 'xhs') {
      return this.parseNumber(
        process.env.MATERIALS_PAGE_SIZE_XHS,
        DEFAULT_PAGE_SIZE
      );
    }
    if (platform === 'dy') {
      return this.parseNumber(
        process.env.MATERIALS_PAGE_SIZE_DY,
        DEFAULT_PAGE_SIZE
      );
    }
    return this.parseNumber(
      process.env.MATERIALS_PAGE_SIZE_DEFAULT,
      DEFAULT_PAGE_SIZE
    );
  }

  private extractQrCode(message: string) {
    const markers = ['QRCODE_BASE64:', 'BROWSER_SCREENSHOT_BASE64:'];
    for (const marker of markers) {
      const index = message.indexOf(marker);
      if (index >= 0) {
        return message.slice(index + marker.length).trim();
      }
    }
    return null;
  }

  private isLoginSuccessMessage(message: string) {
    return (
      /login .*successful/i.test(message) ||
      message.includes('登录成功') ||
      message.includes('Login successful')
    );
  }

  private isSmsRequiredMessage(message: string) {
    return message.includes('SMS_CODE_REQUIRED');
  }

  private isFatalCrawlerLog(message: string) {
    return (
      message.includes('Missing X server or $DISPLAY') ||
      message.includes('TargetClosedError') ||
      message.includes('Crawler exited with code: 1') ||
      message.includes('phone_login_blocked:')
    );
  }

  private isNonContentPayload(
    payload: unknown,
    platform: MediaCrawlerPlatform
  ) {
    const items = this.extractPayloadItems(payload);
    if (items.length === 0) {
      return false;
    }
    const sample = items.find(
      (item) => item && typeof item === 'object'
    ) as Record<string, unknown> | undefined;
    if (!sample) {
      return false;
    }
    if ('comment_id' in sample) {
      return true;
    }
    if (platform === 'xhs') {
      return !('note_id' in sample);
    }
    if (platform === 'dy') {
      return !('aweme_id' in sample);
    }
    return false;
  }

  private extractPayloadItems(payload: unknown) {
    if (Array.isArray(payload)) {
      return payload as unknown[];
    }
    if (
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      Array.isArray((payload as { data?: unknown[] }).data)
    ) {
      return (payload as { data?: unknown[] }).data ?? [];
    }
    return [];
  }

  private emitEvent(
    jobId: string | number | null | undefined,
    payload: MaterialsEventPayload
  ) {
    const normalized =
      jobId === undefined || jobId === null ? '' : String(jobId);
    const target = normalized || 'unknown';
    this.eventsService.emit(target, {
      ...payload,
      jobId: normalized || undefined,
    });
  }

  private async cacheResult(
    job: Job<MaterialsJobData, MaterialsJobResult>,
    result: MaterialsJobResult
  ) {
    if (!result.resultPath) {
      return;
    }
    const queryHash =
      job.data.queryHash ||
      this.materials.buildQueryHash({
        orgId: job.data.orgId,
        platform: job.data.platform,
        keywords: job.data.keywords,
        startPage: job.data.startPage,
        pageLimit: job.data.pageLimit,
      });
    try {
      await this.materials.storeCachedResult(queryHash, {
        resultPath: result.resultPath,
        count: result.count,
        preview: result.preview,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown cache error';
      this.logger.warn(`Failed to store materials cache entry: ${message}`);
    }
  }

  private getTimeoutMs() {
    const maxRuntimeSeconds = this.parseNumber(
      process.env.MATERIALS_MAX_RUNTIME_SECONDS,
      0
    );
    if (maxRuntimeSeconds > 0) {
      return maxRuntimeSeconds * 1000;
    }
    return this.parseNumber(
      process.env.MATERIALS_JOB_TIMEOUT_MS,
      DEFAULT_JOB_TIMEOUT_MS
    );
  }

  private getPollIntervalMs() {
    const pollValue =
      process.env.MATERIALS_JOB_POLL_INTERVAL_MS ||
      process.env.MATERIALS_POLL_INTERVAL_MS;
    return this.parseNumber(pollValue, DEFAULT_POLL_INTERVAL_MS);
  }

  private parseNumber(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private ensureEnabled() {
    if (!this.enabled) {
      throw new Error('Materials queue requires REDIS_URL to be set.');
    }
  }

  private getJobId(job: Job) {
    if (job.id === undefined || job.id === null) {
      return '';
    }
    return String(job.id);
  }

  private async isJobCancelled(jobId: string) {
    if (!jobId) {
      return false;
    }
    const cancelled = await ioRedis.get(this.cancelKeyPrefix + jobId);
    return cancelled === '1';
  }

  private async downloadAssets(jsonPath: string, jobId: string) {
    if (!fs.existsSync(jsonPath)) return;
    const content = fs.readFileSync(jsonPath, 'utf-8');
    let json: any = {};
    try {
      json = JSON.parse(content);
    } catch (e) {
      return;
    }

    let items: any[] = [];
    if (Array.isArray(json)) items = json;
    else if (json.data && Array.isArray(json.data)) items = json.data;
    else return;

    const downloadDir = path.join(process.cwd(), 'uploads', 'materials', jobId);
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const downloadFile = async (url: string, prefix: string): Promise<string | null> => {
      if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
      try {
        const urlObj = new URL(url);
        let ext = path.extname(urlObj.pathname);
        if (!ext || ext.length > 5) ext = prefix.startsWith('video') ? '.mp4' : '.jpg';

        const filename = `${prefix}_${uuidv4()}${ext}`;
        const filePath = path.join(downloadDir, filename);

        if (!fs.existsSync(filePath)) {
          await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 20000
          }).then(response => {
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            return new Promise((resolve, reject) => {
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
          });
        }
        return `local:${jobId}/${filename}`;
      } catch (e) {
        this.logger.warn(`Failed to download ${url}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Handle fields that can be arrays or comma-separated strings
      const listFields = ['image_list', 'images', 'image_urls'];
      for (const field of listFields) {
        if (!item[field]) continue;

        let urls: string[] = [];
        if (Array.isArray(item[field])) {
          urls = item[field];
        } else if (typeof item[field] === 'string') {
          urls = item[field].split(',').map((u: string) => u.trim()).filter((u: string) => u);
        }

        if (urls.length > 0) {
          const newUrls: string[] = [];
          for (let j = 0; j < urls.length; j++) {
            const local = await downloadFile(urls[j], `image_${i}_${j}`);
            newUrls.push(local || urls[j]);
          }
          item[field] = newUrls;
        }
      }

      // Handle single string fields
      const singleFields = ['cover', 'cover_url', 'video_cover', 'video_url'];
      for (const field of singleFields) {
        if (!item[field] || typeof item[field] !== 'string') continue;
        const prefix = field.includes('video') && !field.includes('cover') ? 'video' : 'image';
        const local = await downloadFile(item[field], `${prefix}_${i}`);
        if (local) item[field] = local;
      }
    }

    if (Array.isArray(json)) json = items;
    else if (json.data) json.data = items;

    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  }
}
