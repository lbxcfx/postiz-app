import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Job, Queue, Worker } from 'bullmq';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { MaterialsAnalysisService } from '@gitroom/nestjs-libraries/materials/materials.analysis.service';

type MaterialAnalysisJobItem = {
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

type MaterialAnalysisJobData = {
  orgId: string;
  item: MaterialAnalysisJobItem;
  force: boolean;
};

type MaterialAnalysisJobResult = {
  source: 'cache' | 'fresh';
  data: unknown;
};

type MaterialAnalysisEnqueueResult = {
  jobId: string;
  reused: boolean;
  reason: 'new' | 'existing' | 'inflight';
  dedupeKey: string;
};

type MaterialAnalysisStatus = {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing';
  progress: number;
  message?: string;
  error?: string | null;
  result?: MaterialAnalysisJobResult | null;
  queuePosition?: number | null;
  resultSource?: 'cache' | 'fresh' | null;
  cacheHit?: boolean;
  orgId?: string;
};

type MaterialAnalysisMetrics = {
  enqueuedNew: number;
  reusedInflight: number;
  reusedExisting: number;
  workerCacheHit: number;
  workerFreshRun: number;
  cancelRequestedRunning: number;
  cancelQueued: number;
  cancelled: number;
};

type MaterialAnalysisMetricsPoint = {
  generatedAt: string;
  cacheHitRate: number;
  workerCacheHit: number;
  workerFreshRun: number;
  enqueuedNew: number;
  reusedInflight: number;
  reusedExisting: number;
  cancelRequestedRunning: number;
  cancelQueued: number;
  cancelled: number;
};

@Injectable()
export class MaterialsAnalysisQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaterialsAnalysisQueueService.name);
  private readonly enabled = Boolean(process.env.REDIS_URL);
  private readonly queueName =
    process.env.MATERIALS_ANALYSIS_QUEUE_NAME || 'materials-analysis';
  private readonly workerConcurrency = Math.max(
    1,
    Number(process.env.MATERIALS_ANALYSIS_CONCURRENCY || 2)
  );
  private readonly inflightPrefix = 'materials:analysis:inflight:';
  private readonly cancelPrefix = 'materials:analysis:cancel:';
  private readonly cancelledPrefix = 'materials:analysis:cancelled:';
  private readonly cancelMarker = '__CANCELLED_BY_USER__';
  private readonly metricsPrefix = 'materials:analysis:metrics:';
  private readonly metricsHistoryPrefix = 'materials:analysis:metrics-history:';
  private readonly enqueueLockPrefix = 'materials:analysis:enqueue-lock:';
  private readonly inflightTtlSec = Number(
    process.env.MATERIALS_ANALYSIS_INFLIGHT_TTL_SEC || 60 * 30
  );
  private readonly cancelTtlSec = Number(
    process.env.MATERIALS_ANALYSIS_CANCEL_TTL_SEC || 60 * 30
  );
  private readonly metricsTtlSec = Number(
    process.env.MATERIALS_ANALYSIS_METRICS_TTL_SEC || 60 * 60 * 24 * 7
  );
  private readonly metricsHistoryTtlSec = Number(
    process.env.MATERIALS_ANALYSIS_METRICS_HISTORY_TTL_SEC || 60 * 60 * 24 * 7
  );
  private readonly metricsHistoryMaxPoints = Math.max(
    10,
    Number(process.env.MATERIALS_ANALYSIS_METRICS_HISTORY_MAX || 240)
  );
  private readonly enqueueLockTtlSec = Math.max(
    3,
    Number(process.env.MATERIALS_ANALYSIS_ENQUEUE_LOCK_TTL_SEC || 8)
  );
  private readonly enqueueLockWaitMs = Math.max(
    100,
    Number(process.env.MATERIALS_ANALYSIS_ENQUEUE_LOCK_WAIT_MS || 1500)
  );
  private readonly enqueueLockRetryMs = Math.max(
    20,
    Number(process.env.MATERIALS_ANALYSIS_ENQUEUE_LOCK_RETRY_MS || 80)
  );
  private queue: Queue<MaterialAnalysisJobData, MaterialAnalysisJobResult> | null = null;
  private worker: Worker<MaterialAnalysisJobData, MaterialAnalysisJobResult> | null = null;
  private memoryJobs = new Map<string, MaterialAnalysisStatus>();
  private memoryInflight = new Map<string, string>();
  private memoryCancelRequests = new Set<string>();
  private memoryMetrics = new Map<string, MaterialAnalysisMetrics>();
  private memoryMetricsHistory = new Map<string, MaterialAnalysisMetricsPoint[]>();

  constructor(private readonly analysisService: MaterialsAnalysisService) {}

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'REDIS_URL is not set; materials analysis queue will run in memory mode.'
      );
      return;
    }

    this.queue = new Queue(this.queueName, {
      connection: ioRedis,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: { age: 60 * 60 * 24 },
        removeOnFail: { age: 60 * 60 * 24 },
      },
    });

    this.worker = new Worker(
      this.queueName,
      async (job) => {
        const { orgId, item, force } = job.data;
        const jobId = String(job.id || '');
        const stableId = this.buildStableJobIdFromData(job.data);
        const abortController = new AbortController();
        const stopCancelWatch = this.startCancelWatch(jobId, stableId, abortController);
        try {
          await this.throwIfCancelled(job);
          await job.updateProgress({
            progress: 0.2,
            message: 'Loading existing analysis...',
          });
          if (!force) {
            const existing = await this.analysisService.getLatestAnalysis(
              orgId,
              item.platform,
              item.externalId
            );
            if (existing) {
              this.logger.log(
                `analysis queue worker cache-hit org=${orgId} platform=${item.platform} externalId=${item.externalId} jobId=${job.id}`
              );
              await this.incrementMetric(orgId, 'workerCacheHit');
              await job.updateProgress({
                progress: 1,
                message: 'Cache hit',
              });
              return {
                source: 'cache',
                data: existing,
              };
            }
          }

          await this.throwIfCancelled(job);
          await job.updateProgress({
            progress: 0.55,
            message: 'Running model analysis...',
          });
          const analyzed = await this.analysisService.analyzeAndStore(orgId, item, {
            signal: abortController.signal,
          });
          await this.throwIfCancelled(job);
          this.logger.log(
            `analysis queue worker fresh-run org=${orgId} platform=${item.platform} externalId=${item.externalId} jobId=${job.id}`
          );
          await this.incrementMetric(orgId, 'workerFreshRun');
          await job.updateProgress({
            progress: 1,
            message: 'Completed',
          });
          return {
            source: 'fresh',
            data: analyzed,
          };
        } finally {
          stopCancelWatch();
        }
      },
      {
        connection: ioRedis,
        concurrency: this.workerConcurrency,
      }
    );
    this.logger.log(
      `analysis queue worker started queue=${this.queueName} concurrency=${this.workerConcurrency}`
    );

    this.worker.on('completed', async (job) => {
      await this.clearInflightJobId(this.buildStableJobIdFromData(job.data), String(job.id || ''));
      await this.clearCancelRequested(String(job.id || ''));
    });
    this.worker.on('failed', async (job, error) => {
      if (!job) return;
      await this.clearInflightJobId(this.buildStableJobIdFromData(job.data), String(job.id || ''));
      const failedMessage = error instanceof Error ? error.message : '';
      if (failedMessage.includes(this.cancelMarker)) {
        await this.markCancelledStatus(String(job.id || ''), job.data.orgId);
      }
      await this.clearCancelRequested(String(job.id || ''));
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async enqueueJob(input: MaterialAnalysisJobData): Promise<MaterialAnalysisEnqueueResult> {
    const stableId = this.buildStableJobId(
      input.orgId,
      input.item.platform,
      input.item.externalId
    );
    const jobId = input.force ? `${stableId}:${Date.now()}` : stableId;

    if (!this.enabled) {
      const inflight = this.memoryInflight.get(stableId);
      if (inflight) {
        const inflightStatus = this.memoryJobs.get(inflight);
        if (
          inflightStatus &&
          inflightStatus.state !== 'failed' &&
          inflightStatus.state !== 'cancelled' &&
          inflightStatus.state !== 'missing'
        ) {
          await this.incrementMetric(input.orgId, 'reusedInflight');
          return { jobId: inflight, reused: true, reason: 'inflight', dedupeKey: stableId };
        }
        this.memoryInflight.delete(stableId);
      }
      if (!input.force) {
        const existing = this.memoryJobs.get(jobId);
        if (existing && existing.state !== 'failed' && existing.state !== 'cancelled') {
          await this.incrementMetric(input.orgId, 'reusedExisting');
          return { jobId, reused: true, reason: 'existing', dedupeKey: stableId };
        }
      }
      this.memoryInflight.set(stableId, jobId);
      this.runInMemoryJob(jobId, input);
      await this.incrementMetric(input.orgId, 'enqueuedNew');
      return { jobId, reused: false, reason: 'new', dedupeKey: stableId };
    }

    if (!this.queue) {
      throw new Error('Materials analysis queue is not initialized');
    }

    return this.withStableEnqueueLock(stableId, async () => {
      const inflightJobId = await this.getInflightJobId(stableId);
      if (inflightJobId) {
        this.logger.log(
          `analysis queue reuse inflight stableId=${stableId} jobId=${inflightJobId}`
        );
        await this.incrementMetric(input.orgId, 'reusedInflight');
        return {
          jobId: inflightJobId,
          reused: true,
          reason: 'inflight' as const,
          dedupeKey: stableId,
        };
      }

      if (!input.force) {
        const existing = await this.queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state !== 'failed' && state !== 'unknown') {
            await this.setInflightJobId(stableId, jobId);
            this.logger.log(
              `analysis queue reuse existing stableId=${stableId} jobId=${jobId} state=${state}`
            );
            await this.incrementMetric(input.orgId, 'reusedExisting');
            return { jobId, reused: true, reason: 'existing' as const, dedupeKey: stableId };
          }
        }
      }

      await this.queue.add('analyze', input, { jobId });
      await this.setInflightJobId(stableId, jobId);
      this.logger.log(
        `analysis queue enqueue new stableId=${stableId} jobId=${jobId} force=${input.force}`
      );
      await this.incrementMetric(input.orgId, 'enqueuedNew');
      return { jobId, reused: false, reason: 'new' as const, dedupeKey: stableId };
    });
  }

  async getJobStatus(jobId: string, orgId?: string): Promise<MaterialAnalysisStatus> {
    if (!this.enabled) {
      const status = this.memoryJobs.get(jobId);
      if (!status) {
        return {
          jobId,
          state: 'missing',
          progress: 0,
          error: null,
          result: null,
          resultSource: null,
          cacheHit: false,
        };
      }
      if (orgId && status.orgId && status.orgId !== orgId) {
        return {
          jobId,
          state: 'missing',
          progress: 0,
          error: null,
          result: null,
          resultSource: null,
          cacheHit: false,
        };
      }
      return status;
    }

    if (!this.queue) {
      throw new Error('Materials analysis queue is not initialized');
    }

    const job = await this.queue.getJob(jobId);
    if (!job) {
      const cancelled = await this.getCancelledStatus(jobId);
      if (cancelled) {
        return cancelled;
      }
      return {
        jobId,
        state: 'missing',
        progress: 0,
        error: null,
        result: null,
        resultSource: null,
        cacheHit: false,
      };
    }
    if (orgId && job.data.orgId !== orgId) {
      return {
        jobId,
        state: 'missing',
        progress: 0,
        error: null,
        result: null,
        resultSource: null,
        cacheHit: false,
      };
    }

    const state = await job.getState();
    const progressPayload = this.extractProgress(job.progress);
    const queuePosition =
      state === 'waiting' || state === 'delayed'
        ? await this.getQueuePosition(job.id)
        : null;
    const normalizedState =
      state === 'waiting' || state === 'delayed'
        ? 'queued'
        : state === 'active'
        ? 'running'
        : state === 'completed'
        ? 'succeeded'
        : state === 'failed' && String(job.failedReason || '').includes(this.cancelMarker)
        ? 'cancelled'
        : state === 'failed'
        ? 'failed'
        : 'running';

    const resultPayload =
      normalizedState === 'succeeded'
        ? ((job.returnvalue as MaterialAnalysisJobResult) || null)
        : null;

    return {
      jobId,
      state: normalizedState,
      progress: progressPayload.progress,
      message:
        normalizedState === 'cancelled'
          ? 'Cancelled by user'
          : progressPayload.message,
      error: job.failedReason || null,
      result: resultPayload,
      queuePosition,
      resultSource: resultPayload?.source || null,
      cacheHit: resultPayload?.source === 'cache',
      orgId: job.data.orgId,
    };
  }

  async cancelJob(jobId: string, orgId?: string) {
    const normalizedJobId = String(jobId || '').trim();
    if (!normalizedJobId) {
      return {
        cancelled: false,
        state: 'missing' as const,
        message: 'jobId is required',
      };
    }

    if (!this.enabled) {
      const status = this.memoryJobs.get(normalizedJobId);
      if (!status) {
        return {
          cancelled: false,
          state: 'missing' as const,
          message: 'Job not found',
        };
      }
      if (orgId && status.orgId && status.orgId !== orgId) {
        return {
          cancelled: false,
          state: 'missing' as const,
          message: 'Job not found',
        };
      }

      if (status.state === 'queued') {
        this.memoryJobs.set(normalizedJobId, {
          ...status,
          state: 'cancelled',
          message: 'Cancelled by user',
          error: this.cancelMarker,
          result: null,
          resultSource: null,
          cacheHit: false,
        });
        await this.incrementMetric(status.orgId || 'unknown', 'cancelQueued');
        await this.incrementMetric(status.orgId || 'unknown', 'cancelled');
        this.removeMemoryInflightByJobId(normalizedJobId);
      } else {
        this.memoryCancelRequests.add(normalizedJobId);
        await this.incrementMetric(status.orgId || 'unknown', 'cancelRequestedRunning');
      }
      return {
        cancelled: true,
        state: status.state === 'queued' ? ('cancelled' as const) : ('running' as const),
        message:
          status.state === 'queued'
            ? 'Cancelled queued task'
            : 'Cancel requested. Running task will stop on next checkpoint.',
      };
    }

    if (!this.queue) {
      throw new Error('Materials analysis queue is not initialized');
    }

    const job = await this.queue.getJob(normalizedJobId);
    if (!job) {
      const cancelled = await this.getCancelledStatus(normalizedJobId);
      if (cancelled) {
        return {
          cancelled: true,
          state: 'cancelled' as const,
          message: cancelled.message || 'Already cancelled',
        };
      }
      return {
        cancelled: false,
        state: 'missing' as const,
        message: 'Job not found',
      };
    }
    if (orgId && job.data.orgId !== orgId) {
      return {
        cancelled: false,
        state: 'missing' as const,
        message: 'Job not found',
      };
    }

    const state = await job.getState();
    if (state === 'completed') {
      return {
        cancelled: false,
        state: 'succeeded' as const,
        message: 'Job is already completed',
      };
    }
    if (state === 'failed') {
      const isCancelled = String(job.failedReason || '').includes(this.cancelMarker);
      return {
        cancelled: isCancelled,
        state: isCancelled ? ('cancelled' as const) : ('failed' as const),
        message: isCancelled ? 'Job already cancelled' : 'Job is already failed',
      };
    }

    if (state === 'waiting' || state === 'delayed') {
      const stableId = this.buildStableJobIdFromData(job.data);
      await job.remove();
      await this.clearInflightJobId(stableId, normalizedJobId);
      await this.clearCancelRequested(normalizedJobId);
      await this.markCancelledStatus(normalizedJobId, job.data.orgId);
      await this.incrementMetric(job.data.orgId, 'cancelQueued');
      await this.incrementMetric(job.data.orgId, 'cancelled');
      this.logger.log(`analysis queue cancel queued jobId=${normalizedJobId}`);
      return {
        cancelled: true,
        state: 'cancelled' as const,
        message: 'Cancelled queued task',
      };
    }

    if (state === 'active') {
      const stableId = this.buildStableJobIdFromData(job.data);
      await this.markCancelRequested(normalizedJobId);
      await this.clearInflightJobId(stableId, normalizedJobId);
      await this.incrementMetric(job.data.orgId, 'cancelRequestedRunning');
      this.logger.log(`analysis queue cancel requested for active jobId=${normalizedJobId}`);
      return {
        cancelled: true,
        state: 'running' as const,
        message: 'Cancel requested. Running task will stop on next checkpoint.',
      };
    }

    return {
      cancelled: false,
      state: 'missing' as const,
      message: `Unsupported state: ${state}`,
    };
  }

  async incrementMetric(orgId: string, metric: keyof MaterialAnalysisMetrics, delta = 1) {
    const normalizedOrgId = String(orgId || '').trim() || 'unknown';
    if (!this.enabled) {
      const current = this.getMemoryMetrics(normalizedOrgId);
      current[metric] += delta;
      this.memoryMetrics.set(normalizedOrgId, current);
      return;
    }
    const key = this.metricsRedisKey(normalizedOrgId);
    await ioRedis.hincrby(key, metric, delta);
    await ioRedis.expire(key, this.metricsTtlSec);
  }

  async getMetrics(orgId: string): Promise<MaterialAnalysisMetrics> {
    const normalizedOrgId = String(orgId || '').trim() || 'unknown';
    if (!this.enabled) {
      return this.getMemoryMetrics(normalizedOrgId);
    }
    const key = this.metricsRedisKey(normalizedOrgId);
    const raw = await ioRedis.hgetall(key);
    return {
      enqueuedNew: Number(raw.enqueuedNew || 0),
      reusedInflight: Number(raw.reusedInflight || 0),
      reusedExisting: Number(raw.reusedExisting || 0),
      workerCacheHit: Number(raw.workerCacheHit || 0),
      workerFreshRun: Number(raw.workerFreshRun || 0),
      cancelRequestedRunning: Number(raw.cancelRequestedRunning || 0),
      cancelQueued: Number(raw.cancelQueued || 0),
      cancelled: Number(raw.cancelled || 0),
    };
  }

  async appendMetricsHistory(orgId: string, point: MaterialAnalysisMetricsPoint) {
    const normalizedOrgId = String(orgId || '').trim() || 'unknown';
    if (!this.enabled) {
      const next = [...this.getMemoryMetricsHistory(normalizedOrgId), point];
      const trimmed = next.slice(-this.metricsHistoryMaxPoints);
      this.memoryMetricsHistory.set(normalizedOrgId, trimmed);
      return;
    }
    const key = this.metricsHistoryRedisKey(normalizedOrgId);
    await ioRedis.lpush(key, JSON.stringify(point));
    await ioRedis.ltrim(key, 0, this.metricsHistoryMaxPoints - 1);
    await ioRedis.expire(key, this.metricsHistoryTtlSec);
  }

  async getMetricsHistory(orgId: string, limit = 30): Promise<MaterialAnalysisMetricsPoint[]> {
    const normalizedOrgId = String(orgId || '').trim() || 'unknown';
    const boundedLimit = Math.max(1, Math.min(limit, this.metricsHistoryMaxPoints));
    if (!this.enabled) {
      const history = this.getMemoryMetricsHistory(normalizedOrgId);
      return history.slice(-boundedLimit);
    }
    const key = this.metricsHistoryRedisKey(normalizedOrgId);
    const raw = await ioRedis.lrange(key, 0, boundedLimit - 1);
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as MaterialAnalysisMetricsPoint;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is MaterialAnalysisMetricsPoint => Boolean(entry))
      .reverse();
  }

  private buildStableJobId(orgId: string, platform: string, externalId: string) {
    return `materials-analysis:${createHash('md5')
      .update(`${orgId}:${platform}:${externalId}`)
      .digest('hex')}`;
  }

  private buildStableJobIdFromData(data: MaterialAnalysisJobData) {
    return this.buildStableJobId(data.orgId, data.item.platform, data.item.externalId);
  }

  private inflightRedisKey(stableId: string) {
    return `${this.inflightPrefix}${stableId}`;
  }

  private metricsRedisKey(orgId: string) {
    return `${this.metricsPrefix}${orgId}`;
  }

  private metricsHistoryRedisKey(orgId: string) {
    return `${this.metricsHistoryPrefix}${orgId}`;
  }

  private enqueueLockRedisKey(stableId: string) {
    return `${this.enqueueLockPrefix}${stableId}`;
  }

  private getMemoryMetrics(orgId: string): MaterialAnalysisMetrics {
    return (
      this.memoryMetrics.get(orgId) || {
        enqueuedNew: 0,
        reusedInflight: 0,
        reusedExisting: 0,
        workerCacheHit: 0,
        workerFreshRun: 0,
        cancelRequestedRunning: 0,
        cancelQueued: 0,
        cancelled: 0,
      }
    );
  }

  private getMemoryMetricsHistory(orgId: string) {
    return this.memoryMetricsHistory.get(orgId) || [];
  }

  private removeMemoryInflightByJobId(jobId: string) {
    for (const [key, value] of this.memoryInflight.entries()) {
      if (value === jobId) {
        this.memoryInflight.delete(key);
      }
    }
  }

  private cancelRedisKey(jobId: string) {
    return `${this.cancelPrefix}${jobId}`;
  }

  private cancelledRedisKey(jobId: string) {
    return `${this.cancelledPrefix}${jobId}`;
  }

  private async withStableEnqueueLock<T>(
    stableId: string,
    action: () => Promise<T>
  ): Promise<T> {
    if (!this.enabled) {
      return action();
    }
    const lockKey = this.enqueueLockRedisKey(stableId);
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const acquired = await this.acquireEnqueueLock(lockKey, token);
    if (!acquired) {
      this.logger.warn(
        `analysis queue enqueue lock timeout stableId=${stableId}; fallback to unlocked dedupe path`
      );
      return action();
    }
    try {
      return await action();
    } finally {
      await this.releaseEnqueueLock(lockKey, token);
    }
  }

  private async acquireEnqueueLock(lockKey: string, token: string) {
    const begin = Date.now();
    while (Date.now() - begin < this.enqueueLockWaitMs) {
      const acquired = await ioRedis.set(
        lockKey,
        token,
        'EX',
        this.enqueueLockTtlSec,
        'NX'
      );
      if (acquired === 'OK') {
        return true;
      }
      await this.delay(this.enqueueLockRetryMs);
    }
    return false;
  }

  private async releaseEnqueueLock(lockKey: string, token: string) {
    try {
      await ioRedis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        token
      );
    } catch {
      // Ignore release failures. Lock expires automatically.
    }
  }

  private delay(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async getInflightJobId(stableId: string) {
    if (!this.queue) return null;
    const key = this.inflightRedisKey(stableId);
    const inflightJobId = await ioRedis.get(key);
    if (!inflightJobId) return null;
    if (await this.isCancelRequested(inflightJobId)) {
      await ioRedis.del(key);
      return null;
    }
    const inflightJob = await this.queue.getJob(inflightJobId);
    if (!inflightJob) {
      await ioRedis.del(key);
      return null;
    }
    const state = await inflightJob.getState();
    if (state === 'failed' || state === 'completed' || state === 'unknown') {
      await ioRedis.del(key);
      return null;
    }
    return inflightJobId;
  }

  private async setInflightJobId(stableId: string, jobId: string) {
    if (!this.enabled) {
      this.memoryInflight.set(stableId, jobId);
      return;
    }
    await ioRedis.set(this.inflightRedisKey(stableId), jobId, 'EX', this.inflightTtlSec);
  }

  private async clearInflightJobId(stableId: string, jobId: string) {
    if (!stableId || !jobId) return;
    if (!this.enabled) {
      if (this.memoryInflight.get(stableId) === jobId) {
        this.memoryInflight.delete(stableId);
      }
      return;
    }
    const key = this.inflightRedisKey(stableId);
    const existing = await ioRedis.get(key);
    if (existing === jobId) {
      await ioRedis.del(key);
    }
  }

  private async throwIfCancelled(job: Job<MaterialAnalysisJobData, MaterialAnalysisJobResult>) {
    const jobId = String(job.id || '');
    if (!jobId) return;
    const cancelled = await this.isCancelRequested(jobId);
    if (!cancelled) return;
    job.discard();
    throw new Error(`${this.cancelMarker} ${jobId}`);
  }

  private startCancelWatch(
    jobId: string,
    stableId: string,
    controller: AbortController
  ): () => void {
    if (!jobId) {
      return () => undefined;
    }
    let stopped = false;
    let running = false;
    const timer = setInterval(() => {
      if (stopped || running) return;
      running = true;
      void (async () => {
        try {
          const cancelled = await this.isCancelRequested(jobId);
          if (!cancelled) {
            return;
          }
          await this.clearInflightJobId(stableId, jobId);
          if (!controller.signal.aborted) {
            controller.abort(new Error(`${this.cancelMarker} ${jobId}`));
          }
        } finally {
          running = false;
        }
      })();
    }, 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async markCancelRequested(jobId: string) {
    if (!jobId) return;
    if (!this.enabled) {
      this.memoryCancelRequests.add(jobId);
      return;
    }
    await ioRedis.set(this.cancelRedisKey(jobId), '1', 'EX', this.cancelTtlSec);
  }

  private async clearCancelRequested(jobId: string) {
    if (!jobId) return;
    if (!this.enabled) {
      this.memoryCancelRequests.delete(jobId);
      return;
    }
    await ioRedis.del(this.cancelRedisKey(jobId));
  }

  private async isCancelRequested(jobId: string) {
    if (!jobId) return false;
    if (!this.enabled) {
      return this.memoryCancelRequests.has(jobId);
    }
    const value = await ioRedis.get(this.cancelRedisKey(jobId));
    return Boolean(value);
  }

  private async markCancelledStatus(jobId: string, orgId?: string) {
    if (!jobId) return;
    if (!this.enabled) {
      if (orgId) {
        await this.incrementMetric(orgId, 'cancelled');
      }
      return;
    }
    await ioRedis.set(this.cancelledRedisKey(jobId), 'Cancelled by user', 'EX', this.cancelTtlSec);
    if (orgId) {
      await this.incrementMetric(orgId, 'cancelled');
    }
  }

  private async getCancelledStatus(jobId: string): Promise<MaterialAnalysisStatus | null> {
    if (!jobId || !this.enabled) {
      return null;
    }
    const message = await ioRedis.get(this.cancelledRedisKey(jobId));
    if (!message) {
      return null;
    }
    return {
      jobId,
      state: 'cancelled',
      progress: 1,
      message,
      error: this.cancelMarker,
      result: null,
      queuePosition: null,
      resultSource: null,
      cacheHit: false,
    };
  }

  private extractProgress(progress: unknown) {
    if (typeof progress === 'number') {
      return { progress, message: undefined as string | undefined };
    }
    if (
      progress &&
      typeof progress === 'object' &&
      'progress' in (progress as Record<string, unknown>)
    ) {
      const value = progress as { progress?: number; message?: string };
      return {
        progress: typeof value.progress === 'number' ? value.progress : 0,
        message: value.message,
      };
    }
    return { progress: 0, message: undefined as string | undefined };
  }

  private async getQueuePosition(rawJobId: string | number | undefined) {
    if (!this.queue || !rawJobId) return null;
    const waitingJobs = await this.queue.getJobs(['waiting', 'delayed']);
    const normalizedJobId = String(rawJobId);
    const index = waitingJobs.findIndex((entry) => String(entry.id) === normalizedJobId);
    return index >= 0 ? index + 1 : null;
  }

  private runInMemoryJob(jobId: string, data: MaterialAnalysisJobData) {
    this.memoryJobs.set(jobId, {
      jobId,
      state: 'queued',
      progress: 0,
      message: 'Queued',
      error: null,
      result: null,
      orgId: data.orgId,
    });

    setTimeout(async () => {
      try {
        if (this.memoryCancelRequests.has(jobId)) {
          this.memoryJobs.set(jobId, {
            jobId,
            state: 'cancelled',
            progress: 1,
            message: 'Cancelled by user',
            error: this.cancelMarker,
            result: null,
            resultSource: null,
            cacheHit: false,
            orgId: data.orgId,
          });
          await this.incrementMetric(data.orgId, 'cancelled');
          this.memoryInflight.delete(this.buildStableJobIdFromData(data));
          this.memoryCancelRequests.delete(jobId);
          return;
        }

        this.memoryJobs.set(jobId, {
          jobId,
          state: 'running',
          progress: 0.4,
          message: 'Running',
          error: null,
          result: null,
          orgId: data.orgId,
        });

        if (!data.force) {
          if (this.memoryCancelRequests.has(jobId)) {
            throw new Error(`${this.cancelMarker} ${jobId}`);
          }
          const existing = await this.analysisService.getLatestAnalysis(
            data.orgId,
            data.item.platform,
            data.item.externalId
          );
          if (existing) {
            this.memoryJobs.set(jobId, {
              jobId,
              state: 'succeeded',
              progress: 1,
              message: 'Cache hit',
              error: null,
              result: {
                source: 'cache',
                data: existing,
              },
              resultSource: 'cache',
              cacheHit: true,
              orgId: data.orgId,
            });
            await this.incrementMetric(data.orgId, 'workerCacheHit');
            this.memoryInflight.delete(this.buildStableJobIdFromData(data));
            this.memoryCancelRequests.delete(jobId);
            return;
          }
        }

        if (this.memoryCancelRequests.has(jobId)) {
          throw new Error(`${this.cancelMarker} ${jobId}`);
        }
        const analyzed = await this.analysisService.analyzeAndStore(
          data.orgId,
          data.item
        );

        if (this.memoryCancelRequests.has(jobId)) {
          throw new Error(`${this.cancelMarker} ${jobId}`);
        }

        this.memoryJobs.set(jobId, {
          jobId,
          state: 'succeeded',
          progress: 1,
          message: 'Completed',
          error: null,
          result: {
            source: 'fresh',
            data: analyzed,
          },
          resultSource: 'fresh',
          cacheHit: false,
          orgId: data.orgId,
        });
        await this.incrementMetric(data.orgId, 'workerFreshRun');
        this.memoryInflight.delete(this.buildStableJobIdFromData(data));
        this.memoryCancelRequests.delete(jobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes(this.cancelMarker)) {
          this.memoryJobs.set(jobId, {
            jobId,
            state: 'cancelled',
            progress: 1,
            message: 'Cancelled by user',
            error: this.cancelMarker,
            result: null,
            resultSource: null,
            cacheHit: false,
            orgId: data.orgId,
          });
          await this.incrementMetric(data.orgId, 'cancelled');
          this.memoryInflight.delete(this.buildStableJobIdFromData(data));
          this.memoryCancelRequests.delete(jobId);
          return;
        }
        this.memoryJobs.set(jobId, {
          jobId,
          state: 'failed',
          progress: 0,
          message: 'Failed',
          error: message,
          result: null,
          orgId: data.orgId,
        });
        this.memoryInflight.delete(this.buildStableJobIdFromData(data));
        this.memoryCancelRequests.delete(jobId);
      }
    }, 0);
  }
}
