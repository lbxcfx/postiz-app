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

type MaterialAnalysisStatus = {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'missing';
  progress: number;
  message?: string;
  error?: string | null;
  result?: MaterialAnalysisJobResult | null;
  orgId?: string;
};

@Injectable()
export class MaterialsAnalysisQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaterialsAnalysisQueueService.name);
  private readonly enabled = Boolean(process.env.REDIS_URL);
  private readonly queueName =
    process.env.MATERIALS_ANALYSIS_QUEUE_NAME || 'materials-analysis';
  private queue: Queue<MaterialAnalysisJobData, MaterialAnalysisJobResult> | null = null;
  private worker: Worker<MaterialAnalysisJobData, MaterialAnalysisJobResult> | null = null;
  private memoryJobs = new Map<string, MaterialAnalysisStatus>();

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
        await job.updateProgress({
          progress: 0.2,
          message: 'Loading existing analysis...',
        });
        const { orgId, item, force } = job.data;
        if (!force) {
          const existing = await this.analysisService.getLatestAnalysis(
            orgId,
            item.platform,
            item.externalId
          );
          if (existing) {
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

        await job.updateProgress({
          progress: 0.55,
          message: 'Running model analysis...',
        });
        const analyzed = await this.analysisService.analyzeAndStore(orgId, item);
        await job.updateProgress({
          progress: 1,
          message: 'Completed',
        });
        return {
          source: 'fresh',
          data: analyzed,
        };
      },
      {
        connection: ioRedis,
        concurrency: 2,
      }
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async enqueueJob(input: MaterialAnalysisJobData) {
    const stableId = this.buildStableJobId(
      input.orgId,
      input.item.platform,
      input.item.externalId
    );
    const jobId = input.force ? `${stableId}:${Date.now()}` : stableId;

    if (!this.enabled) {
      if (!input.force) {
        const existing = this.memoryJobs.get(jobId);
        if (existing && existing.state !== 'failed') {
          return { jobId, reused: true };
        }
      }
      this.runInMemoryJob(jobId, input);
      return { jobId, reused: false };
    }

    if (!this.queue) {
      throw new Error('Materials analysis queue is not initialized');
    }

    if (!input.force) {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'unknown') {
          return { jobId, reused: true };
        }
      }
    }

    await this.queue.add('analyze', input, { jobId });
    return { jobId, reused: false };
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
        };
      }
      if (orgId && status.orgId && status.orgId !== orgId) {
        return {
          jobId,
          state: 'missing',
          progress: 0,
          error: null,
          result: null,
        };
      }
      return status;
    }

    if (!this.queue) {
      throw new Error('Materials analysis queue is not initialized');
    }

    const job = await this.queue.getJob(jobId);
    if (!job) {
      return {
        jobId,
        state: 'missing',
        progress: 0,
        error: null,
        result: null,
      };
    }
    if (orgId && job.data.orgId !== orgId) {
      return {
        jobId,
        state: 'missing',
        progress: 0,
        error: null,
        result: null,
      };
    }

    const state = await job.getState();
    const progressPayload = this.extractProgress(job.progress);
    const normalizedState =
      state === 'waiting' || state === 'delayed'
        ? 'queued'
        : state === 'active'
        ? 'running'
        : state === 'completed'
        ? 'succeeded'
        : state === 'failed'
        ? 'failed'
        : 'running';

    return {
      jobId,
      state: normalizedState,
      progress: progressPayload.progress,
      message: progressPayload.message,
      error: job.failedReason || null,
      result:
        normalizedState === 'succeeded'
          ? ((job.returnvalue as MaterialAnalysisJobResult) || null)
          : null,
      orgId: job.data.orgId,
    };
  }

  private buildStableJobId(orgId: string, platform: string, externalId: string) {
    return `materials-analysis:${createHash('md5')
      .update(`${orgId}:${platform}:${externalId}`)
      .digest('hex')}`;
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
              orgId: data.orgId,
            });
            return;
          }
        }

        const analyzed = await this.analysisService.analyzeAndStore(
          data.orgId,
          data.item
        );

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
          orgId: data.orgId,
        });
      } catch (error) {
        this.memoryJobs.set(jobId, {
          jobId,
          state: 'failed',
          progress: 0,
          message: 'Failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          result: null,
          orgId: data.orgId,
        });
      }
    }, 0);
  }
}
