import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import { organizationId } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { ReviewStatus } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';

export type StartFactoryWorkflowInput = {
  operatorId: string;
  integrationId: string;
  collectParams: {
    platform: 'xhs' | 'dy';
    keywords: string;
    startPage?: number;
    pageLimit?: number;
    queryHash?: string;
  };
  productProfile?: Record<string, unknown>;
  scheduleAt?: string;
  idempotencyKey?: string;
};

type SortOrder = 'asc' | 'desc';
type WorkflowFilterStatus = 'ALL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

@Injectable()
export class FactoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalService,
    private readonly integrationService: IntegrationService,
    private readonly integrationManager: IntegrationManager
  ) {}

  private badRequest(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message });
  }

  private notFound(code: string, message: string): NotFoundException {
    return new NotFoundException({ code, message });
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<PromiseSettledResult<R>[]> {
    const limit = Math.max(1, Math.min(concurrency, 20));
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const current = cursor;
        cursor += 1;
        if (current >= items.length) {
          return;
        }
        try {
          const value = await mapper(items[current], current);
          results[current] = { status: 'fulfilled', value };
        } catch (reason) {
          results[current] = { status: 'rejected', reason };
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
  }

  private parseSourceContentIds(value: string | null | undefined) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => typeof item === 'string' && item.trim().length > 0);
    } catch {
      return [];
    }
  }

  private normalizeMediaPath(pathValue: string) {
    if (!pathValue) return '';
    if (/^https?:\/\//i.test(pathValue)) return pathValue;
    if (pathValue.startsWith('local:')) {
      return `materials/${pathValue.replace('local:', '')}`;
    }
    return pathValue;
  }

  private inferMediaType(pathValue: string): 'image' | 'video' {
    return /\.(mp4|mov|mkv|avi|webm|m4v)(\?|#|$)/i.test(pathValue)
      ? 'video'
      : 'image';
  }

  private buildPostMedia(
    assets: Array<{ id: string; url: string; localPath: string | null }>
  ) {
    return assets
      .map((asset) => {
        const rawPath = asset.localPath || asset.url || '';
        const normalizedPath = this.normalizeMediaPath(rawPath);
        if (!normalizedPath) return null;
        return {
          id: asset.id,
          path: normalizedPath,
          type: this.inferMediaType(normalizedPath),
        };
      })
      .filter(
        (item): item is { id: string; path: string; type: 'image' | 'video' } =>
          Boolean(item)
      );
  }

  private requiresMediaPrecheck(providerIdentifier: string) {
    const id = (providerIdentifier || '').toLowerCase();
    return id.includes('xiaohongshu') || id === 'xhs';
  }

  async startWorkflow(orgId: string, input: StartFactoryWorkflowInput) {
    if (!input?.integrationId) {
      throw this.badRequest('FACTORY_INTEGRATION_REQUIRED', 'integrationId is required');
    }
    if (!input?.collectParams?.platform || !input?.collectParams?.keywords) {
      throw this.badRequest(
        'FACTORY_COLLECT_PARAMS_REQUIRED',
        'collectParams.platform and collectParams.keywords are required'
      );
    }

    const workflowId = input.idempotencyKey
      ? `content_factory_${orgId}_${input.idempotencyKey}`
      : `content_factory_${orgId}_${Date.now()}`;

    const exist = await this.prisma.contentDraft.findFirst({
      where: { organizationId: orgId, workflowId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (exist) {
      return {
        workflowId,
        draftId: exist.id,
        existed: true,
      };
    }

    const draft = await this.prisma.contentDraft.create({
      data: {
        organizationId: orgId,
        reviewStatus: ReviewStatus.PENDING,
        workflowId,
        productProfile: (input.productProfile || {}) as object,
      },
    });

    await this.temporal.client
      .getRawClient()
      .workflow.start('contentFactoryWorkflow', {
        workflowId,
        taskQueue: 'main',
        args: [
          {
            organizationId: orgId,
            operatorId: input.operatorId,
            integrationId: input.integrationId,
            collectParams: input.collectParams,
            productProfile: input.productProfile || {},
            scheduleAt: input.scheduleAt,
            workflowId,
            draftId: draft.id,
          },
        ],
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: organizationId,
            value: orgId,
          },
        ]),
      });

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        operator: input.operatorId,
        action: 'create',
        resourceType: 'workflow',
        resourceId: workflowId,
        detail: {
          draftId: draft.id,
          integrationId: input.integrationId,
          collectParams: input.collectParams,
        },
      },
    });

    return {
      workflowId,
      draftId: draft.id,
      existed: false,
    };
  }

  async getWorkflowStatus(orgId: string, workflowId: string) {
    const workflow = await this.temporal.client.getWorkflowHandle(workflowId);
    const description = await workflow.describe();
    const draft = await this.prisma.contentDraft.findFirst({
      where: {
        organizationId: orgId,
        workflowId,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      workflowId,
      status: description.status.name,
      startTime: description.startTime,
      closeTime: description.closeTime,
      draft,
    };
  }

  async getWorkflowDraft(orgId: string, workflowId: string) {
    const draft = await this.prisma.contentDraft.findFirst({
      where: {
        organizationId: orgId,
        workflowId,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      workflowId,
      draft,
    };
  }

  async getWorkflowStatuses(orgId: string, workflowIds: string[]) {
    const uniqueIds = Array.from(new Set((workflowIds || []).filter(Boolean)));
    const entries = await Promise.all(
      uniqueIds.map(async (workflowId) => {
        try {
          const details = await this.getWorkflowStatus(orgId, workflowId);
          return {
            workflowId,
            status: details.status,
            closeTime: details.closeTime || null,
          };
        } catch (error) {
          return {
            workflowId,
            status: 'UNKNOWN',
            closeTime: null,
          };
        }
      })
    );

    return {
      statuses: entries,
    };
  }

  async reviewDraft(
    orgId: string,
    draftId: string,
    input: {
      decision: 'approve' | 'reject';
      note?: string;
      operatorId: string;
    }
  ) {
    const draft = await this.prisma.contentDraft.findFirst({
      where: { id: draftId, organizationId: orgId, deletedAt: null },
    });
    if (!draft) {
      throw this.notFound('FACTORY_DRAFT_NOT_FOUND', 'Draft not found');
    }
    if (!draft.workflowId) {
      throw this.badRequest('FACTORY_DRAFT_NO_WORKFLOW', 'Draft has no workflow');
    }

    const handle = await this.temporal.client.getWorkflowHandle(draft.workflowId);
    await handle.signal('contentFactoryReview', {
      decision: input.decision,
      note: input.note,
      operator: input.operatorId,
    });

    await this.prisma.contentDraft.update({
      where: { id: draftId },
      data: {
        reviewStatus: input.decision === 'approve' ? ReviewStatus.APPROVED : ReviewStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedBy: input.operatorId,
        reviewNote: input.note || null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        operator: input.operatorId,
        action: 'review',
        resourceType: 'draft',
        resourceId: draftId,
        detail: {
          decision: input.decision,
          note: input.note || null,
          workflowId: draft.workflowId,
        },
      },
    });

    return { ok: true };
  }

  async bulkReviewDrafts(
    orgId: string,
    input: {
      draftIds: string[];
      decision: 'approve' | 'reject';
      note?: string;
      operatorId: string;
    }
  ) {
    if (!Array.isArray(input.draftIds) || input.draftIds.length === 0) {
      throw this.badRequest('FACTORY_DRAFT_IDS_REQUIRED', 'draftIds is required');
    }

    const results = await Promise.allSettled(
      input.draftIds.map((draftId) =>
        this.reviewDraft(orgId, draftId, {
          decision: input.decision,
          note: input.note,
          operatorId: input.operatorId,
        })
      )
    );

    const succeeded = results.filter((item) => item.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    const failures = results
      .map((item, index) => ({ item, draftId: input.draftIds[index] }))
      .filter((row) => row.item.status === 'rejected')
      .map((row) => ({
        draftId: row.draftId,
        error:
          row.item.status === 'rejected'
            ? row.item.reason instanceof Error
              ? row.item.reason.message
              : 'unknown error'
            : '',
      }));

    return {
      total: results.length,
      succeeded,
      failed,
      failures,
    };
  }

  async cancelWorkflow(orgId: string, workflowId: string, operatorId: string) {
    const draft = await this.prisma.contentDraft.findFirst({
      where: {
        organizationId: orgId,
        workflowId,
        deletedAt: null,
      },
    });
    if (!draft) {
      throw this.notFound(
        'FACTORY_WORKFLOW_NOT_FOUND',
        'Workflow not found in current organization'
      );
    }

    const workflow = await this.temporal.client.getWorkflowHandle(workflowId);
    await workflow.terminate('Cancelled from factory console');

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        operator: operatorId,
        action: 'cancel',
        resourceType: 'workflow',
        resourceId: workflowId,
        detail: {
          draftId: draft.id,
        },
      },
    });

    return { ok: true };
  }

  async bulkCancelWorkflows(
    orgId: string,
    workflowIds: string[],
    operatorId: string
  ) {
    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      throw this.badRequest(
        'FACTORY_WORKFLOW_IDS_REQUIRED',
        'workflowIds is required'
      );
    }
    const uniqueIds = Array.from(new Set(workflowIds.filter(Boolean)));
    const results = await Promise.allSettled(
      uniqueIds.map((id) => this.cancelWorkflow(orgId, id, operatorId))
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    const failures = results
      .map((result, index) => ({ result, workflowId: uniqueIds[index] }))
      .filter((item) => item.result.status === 'rejected')
      .map((item) => ({
        workflowId: item.workflowId,
        error:
          item.result.status === 'rejected'
            ? item.result.reason instanceof Error
              ? item.result.reason.message
              : 'unknown error'
            : '',
      }));

    return {
      total: results.length,
      succeeded,
      failed,
      failures,
    };
  }

  async getWorkflowsPaged(
    orgId: string,
    options?: {
      page?: number;
      pageSize?: number;
      status?: WorkflowFilterStatus;
      sortBy?: 'createdAt' | 'updatedAt';
      sortOrder?: SortOrder;
    }
  ) {
    const page = Math.max(options?.page || 1, 1);
    const pageSize = Math.min(Math.max(options?.pageSize || 20, 1), 100);
    const sortBy = options?.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
    const sortOrder: SortOrder = options?.sortOrder === 'asc' ? 'asc' : 'desc';
    const statusFilter = options?.status || 'ALL';

    const drafts = await this.prisma.contentDraft.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        workflowId: {
          not: null,
        },
      },
      orderBy: { [sortBy]: sortOrder },
      select: {
        id: true,
        workflowId: true,
        reviewStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const uniqueWorkflowIds = Array.from(
      new Set(drafts.map((draft) => draft.workflowId!).filter(Boolean))
    );
    const statusResults = await this.getWorkflowStatuses(orgId, uniqueWorkflowIds);
    const statusMap = new Map(
      (statusResults.statuses || []).map((item) => [item.workflowId, item.status])
    );

    const filtered = drafts
      .map((draft) => {
        const workflowId = draft.workflowId!;
        const status = statusMap.get(workflowId) || 'UNKNOWN';
        return {
          workflowId,
          status,
          draftId: draft.id,
          reviewStatus: draft.reviewStatus,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        };
      })
      .filter((item) => {
        if (statusFilter === 'ALL') return true;
        if (statusFilter === 'RUNNING') return item.status === 'RUNNING';
        if (statusFilter === 'COMPLETED') return item.status === 'COMPLETED';
        if (statusFilter === 'FAILED') return item.status === 'FAILED';
        if (statusFilter === 'CANCELLED') return item.status === 'TERMINATED';
        return true;
      });

    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      status: statusFilter,
      sortBy,
      sortOrder,
    };
  }

  async getMetricsTrend(
    orgId: string,
    options?: {
      days?: number;
    }
  ) {
    const days = Math.min(Math.max(options?.days || 7, 1), 90);
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    const [publishJobs, drafts, workflowLogs] = await Promise.all([
      this.prisma.publishJob.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: start, lte: end },
        },
        select: {
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.contentDraft.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: start, lte: end },
          deletedAt: null,
        },
        select: {
          reviewStatus: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: start, lte: end },
          resourceType: 'workflow',
          action: { in: ['create', 'cancel', 'workflow_failed'] },
        },
        select: {
          action: true,
          createdAt: true,
        },
      }),
    ]);

    const keyOf = (date: Date) => date.toISOString().slice(0, 10);
    const seriesMap = new Map<
      string,
      {
        date: string;
        publishSuccess: number;
        publishFailed: number;
        draftApproved: number;
        draftRejected: number;
        workflowCreated: number;
        workflowFailed: number;
        workflowCancelled: number;
      }
    >();

    for (let i = 0; i < days; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const key = keyOf(day);
      seriesMap.set(key, {
        date: key,
        publishSuccess: 0,
        publishFailed: 0,
        draftApproved: 0,
        draftRejected: 0,
        workflowCreated: 0,
        workflowFailed: 0,
        workflowCancelled: 0,
      });
    }

    for (const job of publishJobs) {
      const key = keyOf(job.createdAt);
      const bucket = seriesMap.get(key);
      if (!bucket) continue;
      if (job.status === 'PUBLISHED') bucket.publishSuccess += 1;
      if (job.status === 'FAILED') bucket.publishFailed += 1;
    }
    for (const draft of drafts) {
      const key = keyOf(draft.createdAt);
      const bucket = seriesMap.get(key);
      if (!bucket) continue;
      if (draft.reviewStatus === 'APPROVED') bucket.draftApproved += 1;
      if (draft.reviewStatus === 'REJECTED') bucket.draftRejected += 1;
    }
    for (const log of workflowLogs) {
      const key = keyOf(log.createdAt);
      const bucket = seriesMap.get(key);
      if (!bucket) continue;
      if (log.action === 'create') bucket.workflowCreated += 1;
      if (log.action === 'workflow_failed') bucket.workflowFailed += 1;
      if (log.action === 'cancel') bucket.workflowCancelled += 1;
    }

    return {
      windowDays: days,
      series: Array.from(seriesMap.values()),
    };
  }

  async retryPublishJob(orgId: string, publishJobId: string, operatorId: string) {
    const job = await this.prisma.publishJob.findFirst({
      where: {
        id: publishJobId,
        organizationId: orgId,
      },
      include: {
        contentDraft: true,
      },
    });
    if (!job) {
      throw this.notFound('FACTORY_PUBLISH_JOB_NOT_FOUND', 'Publish job not found');
    }

    const integration = await this.integrationService.getIntegrationById(
      orgId,
      job.integrationId
    );
    if (!integration) {
      throw this.notFound('FACTORY_INTEGRATION_NOT_FOUND', 'Integration not found');
    }

    const provider = this.integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!provider?.post) {
      throw this.badRequest(
        'FACTORY_PROVIDER_POST_UNSUPPORTED',
        `Provider ${integration.providerIdentifier} does not support posting`
      );
    }

    const sourceContentIds = this.parseSourceContentIds(job.contentDraft.sourceContentIds);
    const mediaAssets = sourceContentIds.length
      ? await this.prisma.mediaAsset.findMany({
          where: {
            sourceContentId: { in: sourceContentIds },
            type: { in: ['image', 'video'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 12,
        })
      : [];
    const postMedia = this.buildPostMedia(mediaAssets);

    if (this.requiresMediaPrecheck(integration.providerIdentifier) && postMedia.length === 0) {
      const message = 'FACTORY_MEDIA_REQUIRED: at least one image or video is required';
      await this.prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorCode: 'FACTORY_MEDIA_REQUIRED',
          errorMessage: message,
          retryCount: { increment: 1 },
        },
      });
      await this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          operator: operatorId,
          action: 'publish_retry_precheck_failed',
          resourceType: 'publish_job',
          resourceId: job.id,
          detail: {
            reason: 'FACTORY_MEDIA_REQUIRED',
            integrationId: integration.id,
            providerIdentifier: integration.providerIdentifier,
            sourceContentIds,
          },
        },
      });
      throw this.badRequest('FACTORY_MEDIA_REQUIRED', message);
    }

    await this.prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'PUBLISHING',
        retryCount: { increment: 1 },
        errorCode: null,
        errorMessage: null,
      },
    });

    try {
      const result = await provider.post(
        integration.internalId,
        integration.token,
        [
          {
            id: job.contentDraft.id,
            message: job.contentDraft.content || '',
            settings: {},
            media: postMedia,
          },
        ],
        integration as any
      );
      const first = result?.[0];

      await this.prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          externalPostId: first?.postId || null,
          errorCode: null,
          errorMessage: null,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          operator: operatorId,
          action: 'publish_retry',
          resourceType: 'publish_job',
          resourceId: job.id,
          detail: {
            integrationId: integration.id,
            externalPostId: first?.postId || null,
            releaseURL: first?.releaseURL || null,
          },
        },
      });

      return {
        ok: true,
        status: 'PUBLISHED',
        externalPostId: first?.postId || null,
        releaseURL: first?.releaseURL || null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'publish retry failed';
      await this.prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorMessage: message,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          operator: operatorId,
          action: 'publish_retry_failed',
          resourceType: 'publish_job',
          resourceId: job.id,
          detail: {
            error: message,
          },
        },
      });

      throw this.badRequest('FACTORY_PUBLISH_RETRY_FAILED', message);
    }
  }

  async bulkRetryPublishJobs(
    orgId: string,
    publishJobIds: string[],
    operatorId: string,
    options?: {
      concurrency?: number;
    }
  ) {
    if (!Array.isArray(publishJobIds) || publishJobIds.length === 0) {
      throw this.badRequest(
        'FACTORY_PUBLISH_JOB_IDS_REQUIRED',
        'publishJobIds is required'
      );
    }

    const uniqueIds = Array.from(new Set(publishJobIds.filter(Boolean)));
    const results = await this.mapWithConcurrency(
      uniqueIds,
      options?.concurrency || 5,
      (id) => this.retryPublishJob(orgId, id, operatorId)
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    const failures = results
      .map((result, index) => ({ result, id: uniqueIds[index] }))
      .filter((item) => item.result.status === 'rejected')
      .map((item) => ({
        publishJobId: item.id,
        error:
          item.result.status === 'rejected'
            ? item.result.reason instanceof Error
              ? item.result.reason.message
              : 'unknown error'
            : '',
      }));

    return {
      total: results.length,
      succeeded,
      failed,
      failures,
    };
  }

  async getDrafts(orgId: string, limit = 20) {
    return this.prisma.contentDraft.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getDraftsPaged(
    orgId: string,
    options?: {
      page?: number;
      pageSize?: number;
      sortBy?: 'createdAt' | 'updatedAt' | 'reviewStatus' | 'score';
      sortOrder?: SortOrder;
    }
  ) {
    const page = Math.max(options?.page || 1, 1);
    const pageSize = Math.min(Math.max(options?.pageSize || 20, 1), 100);
    const allowedSortBy = new Set(['createdAt', 'updatedAt', 'reviewStatus', 'score']);
    const sortBy = allowedSortBy.has(options?.sortBy || '')
      ? (options!.sortBy as 'createdAt' | 'updatedAt' | 'reviewStatus' | 'score')
      : 'createdAt';
    const sortOrder: SortOrder = options?.sortOrder === 'asc' ? 'asc' : 'desc';
    const where = { organizationId: orgId, deletedAt: null as null };

    const [items, total] = await Promise.all([
      this.prisma.contentDraft.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contentDraft.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      sortBy,
      sortOrder,
    };
  }

  async getSourceContents(orgId: string, limit = 20) {
    return this.prisma.sourceContent.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { mediaAssets: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getSourceContentsPaged(
    orgId: string,
    options?: {
      page?: number;
      pageSize?: number;
      sortBy?: 'createdAt' | 'platform' | 'authorName';
      sortOrder?: SortOrder;
    }
  ) {
    const page = Math.max(options?.page || 1, 1);
    const pageSize = Math.min(Math.max(options?.pageSize || 20, 1), 100);
    const allowedSortBy = new Set(['createdAt', 'platform', 'authorName']);
    const sortBy = allowedSortBy.has(options?.sortBy || '')
      ? (options!.sortBy as 'createdAt' | 'platform' | 'authorName')
      : 'createdAt';
    const sortOrder: SortOrder = options?.sortOrder === 'asc' ? 'asc' : 'desc';
    const where = { organizationId: orgId, deletedAt: null as null };

    const [items, total] = await Promise.all([
      this.prisma.sourceContent.findMany({
        where,
        include: { mediaAssets: true },
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.sourceContent.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      sortBy,
      sortOrder,
    };
  }

  async getPublishJobs(orgId: string, limit = 20) {
    return this.prisma.publishJob.findMany({
      where: { organizationId: orgId },
      include: {
        contentDraft: true,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getPublishJobByDraftId(orgId: string, draftId: string) {
    const publishJob = await this.prisma.publishJob.findFirst({
      where: {
        organizationId: orgId,
        contentDraftId: draftId,
      },
      include: {
        contentDraft: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      draftId,
      publishJob,
    };
  }

  async getPublishJobsPaged(
    orgId: string,
    options?: {
      page?: number;
      pageSize?: number;
      sortBy?: 'createdAt' | 'updatedAt' | 'status' | 'publishedAt' | 'retryCount';
      sortOrder?: SortOrder;
    }
  ) {
    const page = Math.max(options?.page || 1, 1);
    const pageSize = Math.min(Math.max(options?.pageSize || 20, 1), 100);
    const allowedSortBy = new Set([
      'createdAt',
      'updatedAt',
      'status',
      'publishedAt',
      'retryCount',
    ]);
    const sortBy = allowedSortBy.has(options?.sortBy || '')
      ? (options!.sortBy as
          | 'createdAt'
          | 'updatedAt'
          | 'status'
          | 'publishedAt'
          | 'retryCount')
      : 'createdAt';
    const sortOrder: SortOrder = options?.sortOrder === 'asc' ? 'asc' : 'desc';
    const where = { organizationId: orgId };

    const [items, total] = await Promise.all([
      this.prisma.publishJob.findMany({
        where,
        include: { contentDraft: true },
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.publishJob.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      sortBy,
      sortOrder,
    };
  }

  async getAuditLogs(
    orgId: string,
    options?: {
      limit?: number;
      traceId?: string;
      operator?: string;
      action?: string;
      from?: string;
      to?: string;
    }
  ) {
    const limit = options?.limit || 50;
    const fromDate = options?.from ? new Date(options.from) : null;
    const toDate = options?.to ? new Date(options.to) : null;
    return this.prisma.auditLog.findMany({
      where: {
        organizationId: orgId,
        ...(options?.traceId ? { traceId: options.traceId } : {}),
        ...(options?.operator ? { operator: options.operator } : {}),
        ...(options?.action ? { action: options.action } : {}),
        ...(fromDate || toDate
          ? {
              createdAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async getAuditLogsPaged(
    orgId: string,
    options?: {
      page?: number;
      pageSize?: number;
      sortBy?: 'createdAt' | 'action' | 'operator' | 'resourceType';
      sortOrder?: SortOrder;
      traceId?: string;
      operator?: string;
      action?: string;
      from?: string;
      to?: string;
    }
  ) {
    const page = Math.max(options?.page || 1, 1);
    const pageSize = Math.min(Math.max(options?.pageSize || 50, 1), 200);
    const allowedSortBy = new Set(['createdAt', 'action', 'operator', 'resourceType']);
    const sortBy = allowedSortBy.has(options?.sortBy || '')
      ? (options!.sortBy as 'createdAt' | 'action' | 'operator' | 'resourceType')
      : 'createdAt';
    const sortOrder: SortOrder = options?.sortOrder === 'asc' ? 'asc' : 'desc';
    const fromDate = options?.from ? new Date(options.from) : null;
    const toDate = options?.to ? new Date(options.to) : null;

    const where = {
      organizationId: orgId,
      ...(options?.traceId ? { traceId: options.traceId } : {}),
      ...(options?.operator ? { operator: options.operator } : {}),
      ...(options?.action ? { action: options.action } : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      sortBy,
      sortOrder,
    };
  }

  async exportAuditLogsCsv(
    orgId: string,
    options?: {
      limit?: number;
      traceId?: string;
      operator?: string;
      action?: string;
      from?: string;
      to?: string;
    }
  ) {
    const logs = await this.getAuditLogs(orgId, {
      ...options,
      limit: Math.min(options?.limit || 1000, 5000),
    });

    const escape = (value: unknown) => {
      if (value === null || value === undefined) return '';
      const raw =
        typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
      const normalized = raw.replace(/"/g, '""');
      return `"${normalized}"`;
    };

    const header = [
      'id',
      'organization_id',
      'operator',
      'action',
      'resource_type',
      'resource_id',
      'trace_id',
      'created_at',
      'detail',
    ];
    const lines = logs.map((log) =>
      [
        log.id,
        log.organizationId,
        log.operator,
        log.action,
        log.resourceType,
        log.resourceId,
        log.traceId || '',
        log.createdAt.toISOString(),
        log.detail || {},
      ]
        .map(escape)
        .join(',')
    );

    return [header.join(','), ...lines].join('\n');
  }

  async getMetrics(
    orgId: string,
    options?: {
      days?: number;
    }
  ) {
    const days = Math.min(Math.max(options?.days || 7, 1), 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [publishJobs, drafts, workflows] = await Promise.all([
      this.prisma.publishJob.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
        },
        select: {
          status: true,
          retryCount: true,
        },
      }),
      this.prisma.contentDraft.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
          deletedAt: null,
        },
        select: {
          reviewStatus: true,
          workflowId: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
          resourceType: 'workflow',
          action: { in: ['create', 'cancel', 'workflow_failed'] },
        },
        select: {
          action: true,
        },
      }),
    ]);

    const totalPublish = publishJobs.length;
    const publishSuccess = publishJobs.filter((j) => j.status === 'PUBLISHED').length;
    const publishFailed = publishJobs.filter((j) => j.status === 'FAILED').length;
    const publishRetryUsed = publishJobs.filter((j) => j.retryCount > 0).length;

    const totalDraft = drafts.length;
    const pendingReview = drafts.filter((d) => d.reviewStatus === 'PENDING').length;
    const approvedDraft = drafts.filter((d) => d.reviewStatus === 'APPROVED').length;
    const rejectedDraft = drafts.filter((d) => d.reviewStatus === 'REJECTED').length;
    const regeneratingDraft = drafts.filter((d) => d.reviewStatus === 'REGENERATING').length;

    const workflowCreated = workflows.filter((w) => w.action === 'create').length;
    const workflowCancelled = workflows.filter((w) => w.action === 'cancel').length;
    const workflowFailed = workflows.filter((w) => w.action === 'workflow_failed').length;
    const workflowCompletedApprox = Math.max(
      workflowCreated - workflowCancelled - workflowFailed,
      0
    );

    return {
      windowDays: days,
      publish: {
        total: totalPublish,
        published: publishSuccess,
        failed: publishFailed,
        retryUsed: publishRetryUsed,
        successRate: totalPublish > 0 ? Number(((publishSuccess / totalPublish) * 100).toFixed(1)) : 0,
        failRate: totalPublish > 0 ? Number(((publishFailed / totalPublish) * 100).toFixed(1)) : 0,
      },
      review: {
        total: totalDraft,
        pending: pendingReview,
        approved: approvedDraft,
        rejected: rejectedDraft,
        regenerating: regeneratingDraft,
        manualTakeoverRate:
          totalDraft > 0 ? Number((((rejectedDraft + regeneratingDraft) / totalDraft) * 100).toFixed(1)) : 0,
      },
      workflow: {
        created: workflowCreated,
        cancelled: workflowCancelled,
        failed: workflowFailed,
        completedApprox: workflowCompletedApprox,
      },
    };
  }

  async getStageDistribution(
    orgId: string,
    options?: {
      days?: number;
    }
  ) {
    const days = Math.min(Math.max(options?.days || 7, 1), 90);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [drafts, publishJobs, logs] = await Promise.all([
      this.prisma.contentDraft.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
          deletedAt: null,
        },
        select: {
          reviewStatus: true,
        },
      }),
      this.prisma.publishJob.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
        },
        select: {
          status: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          createdAt: { gte: from },
          action: { in: ['collect', 'generate', 'workflow_failed'] },
        },
        select: { action: true },
      }),
    ]);

    const collecting = logs.filter((item) => item.action === 'collect').length;
    const generating = logs.filter((item) => item.action === 'generate').length;
    const reviewing = drafts.filter(
      (item) => item.reviewStatus === 'PENDING' || item.reviewStatus === 'REGENERATING'
    ).length;
    const publishing = publishJobs.filter((item) =>
      ['PENDING', 'SCHEDULED', 'PUBLISHING'].includes(item.status)
    ).length;
    const completed = publishJobs.filter((item) => item.status === 'PUBLISHED').length;
    const failed =
      publishJobs.filter((item) => item.status === 'FAILED').length +
      logs.filter((item) => item.action === 'workflow_failed').length;

    return {
      windowDays: days,
      stages: {
        COLLECTING: collecting,
        GENERATING: generating,
        REVIEWING: reviewing,
        PUBLISHING: publishing,
        COMPLETED: completed,
        FAILED: failed,
      },
    };
  }

  async getPublishRetryInsights(
    orgId: string,
    options?: {
      days?: number;
      maxRetryCount?: number;
    }
  ) {
    const days = Math.min(Math.max(options?.days || 7, 1), 90);
    const maxRetryCount = Math.min(Math.max(options?.maxRetryCount || 3, 0), 10);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const failedJobs = await this.prisma.publishJob.findMany({
      where: {
        organizationId: orgId,
        createdAt: { gte: from },
        status: 'FAILED',
      },
      select: {
        id: true,
        errorCode: true,
        errorMessage: true,
        retryCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const byErrorCodeMap = new Map<
      string,
      { errorCode: string; count: number; retryable: number }
    >();
    for (const job of failedJobs) {
      const key = job.errorCode || 'UNKNOWN';
      const row = byErrorCodeMap.get(key) || { errorCode: key, count: 0, retryable: 0 };
      row.count += 1;
      if (job.retryCount < maxRetryCount) {
        row.retryable += 1;
      }
      byErrorCodeMap.set(key, row);
    }

    return {
      windowDays: days,
      maxRetryCount,
      failedTotal: failedJobs.length,
      retryableTotal: failedJobs.filter((job) => job.retryCount < maxRetryCount).length,
      byErrorCode: Array.from(byErrorCodeMap.values()).sort((a, b) => b.count - a.count),
    };
  }

  async getPublishRetryHistory(
    orgId: string,
    options?: {
      days?: number;
      limit?: number;
      operator?: string;
      skipped?: 'true' | 'false';
      errorCode?: string;
    }
  ) {
    const days = Math.min(Math.max(options?.days || 7, 1), 90);
    const limit = Math.min(Math.max(options?.limit || 20, 1), 5000);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const skippedFilter = options?.skipped;
    const errorCodeFilter = options?.errorCode?.trim() || '';
    const scanLimit = Math.min(Math.max(limit * 30, 300), 5000);

    const logs = await this.prisma.auditLog.findMany({
      where: {
        organizationId: orgId,
        action: 'publish_retry_bulk',
        resourceType: 'publish_job',
        createdAt: { gte: from },
        ...(options?.operator ? { operator: options.operator } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: scanLimit,
      select: {
        id: true,
        operator: true,
        createdAt: true,
        detail: true,
      },
    });

    const mapped = logs.map((log) => {
      const detail = (log.detail || {}) as Record<string, any>;
      const criteria = (detail.criteria || {}) as Record<string, any>;
      const result = (detail.result || {}) as Record<string, any>;
      return {
        id: log.id,
        operator: log.operator,
        createdAt: log.createdAt,
        mode: detail.mode || null,
        skippedByCooldown: Boolean(detail.skippedByCooldown),
        cooldownUntil: detail.cooldownUntil || null,
        criteria: {
          errorCode: criteria.errorCode || null,
          maxRetryCount: Number(criteria.maxRetryCount || 0),
          batchSize: Number(criteria.batchSize || 0),
          cooldownMinutes: Number(criteria.cooldownMinutes || 0),
          concurrency: Number(criteria.concurrency || 0),
          force: Boolean(criteria.force),
        },
        selectedCount: Number(detail.selectedCount || 0),
        result: {
          total: Number(result.total || 0),
          succeeded: Number(result.succeeded || 0),
          failed: Number(result.failed || 0),
        },
      };
    });

    const filtered = mapped.filter((item) => {
      if (skippedFilter === 'true' && !item.skippedByCooldown) return false;
      if (skippedFilter === 'false' && item.skippedByCooldown) return false;
      if (
        errorCodeFilter &&
        String(item.criteria.errorCode || '').toLowerCase() !== errorCodeFilter.toLowerCase()
      ) {
        return false;
      }
      return true;
    });

    return {
      windowDays: days,
      items: filtered.slice(0, limit),
    };
  }

  async getPublishRetryHistorySummary(
    orgId: string,
    options?: {
      days?: number;
      operator?: string;
      skipped?: 'true' | 'false';
      errorCode?: string;
    }
  ) {
    const history = await this.getPublishRetryHistory(orgId, {
      days: options?.days,
      limit: 5000,
      operator: options?.operator,
      skipped: options?.skipped,
      errorCode: options?.errorCode,
    });
    const logs = history.items;

    const byOperatorMap = new Map<
      string,
      { operator: string; total: number; skipped: number; succeeded: number; failed: number }
    >();

    let skipped = 0;
    let executed = 0;
    let succeededJobs = 0;
    let failedJobs = 0;

    for (const log of logs) {
      const result = log.result || { succeeded: 0, failed: 0 };
      const isSkipped = Boolean(log.skippedByCooldown);
      const op = log.operator || 'unknown';
      const row = byOperatorMap.get(op) || {
        operator: op,
        total: 0,
        skipped: 0,
        succeeded: 0,
        failed: 0,
      };
      row.total += 1;
      if (isSkipped) {
        skipped += 1;
        row.skipped += 1;
      } else {
        executed += 1;
        const s = Number(result.succeeded || 0);
        const f = Number(result.failed || 0);
        succeededJobs += s;
        failedJobs += f;
        row.succeeded += s;
        row.failed += f;
      }
      byOperatorMap.set(op, row);
    }

    return {
      windowDays: history.windowDays,
      totalBatches: logs.length,
      skippedBatches: skipped,
      executedBatches: executed,
      succeededJobs,
      failedJobs,
      byOperator: Array.from(byOperatorMap.values()).sort((a, b) => b.total - a.total),
    };
  }

  async exportPublishRetryHistoryCsv(
    orgId: string,
    options?: {
      days?: number;
      limit?: number;
      operator?: string;
      skipped?: 'true' | 'false';
      errorCode?: string;
    }
  ) {
    const history = await this.getPublishRetryHistory(orgId, {
      days: options?.days,
      limit: Math.min(options?.limit || 1000, 5000),
      operator: options?.operator,
      skipped: options?.skipped,
      errorCode: options?.errorCode,
    });

    const escape = (value: unknown) => {
      if (value === null || value === undefined) return '';
      const raw =
        typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `"${raw.replace(/"/g, '""')}"`;
    };

    const header = [
      'id',
      'operator',
      'created_at',
      'mode',
      'skipped_by_cooldown',
      'cooldown_until',
      'error_code',
      'max_retry_count',
      'batch_size',
      'cooldown_minutes',
      'concurrency',
      'force',
      'selected_count',
      'result_total',
      'result_succeeded',
      'result_failed',
    ];

    const lines = history.items.map((item) =>
      [
        item.id,
        item.operator,
        item.createdAt.toISOString(),
        item.mode || '',
        item.skippedByCooldown ? '1' : '0',
        item.cooldownUntil || '',
        item.criteria.errorCode || '',
        item.criteria.maxRetryCount,
        item.criteria.batchSize,
        item.criteria.cooldownMinutes,
        item.criteria.concurrency,
        item.criteria.force ? '1' : '0',
        item.selectedCount,
        item.result.total,
        item.result.succeeded,
        item.result.failed,
      ]
        .map(escape)
        .join(',')
    );

    return [header.join(','), ...lines].join('\n');
  }

  async replayPublishRetryHistory(
    orgId: string,
    operatorId: string,
    logId: string,
    input?: {
      force?: boolean;
      cooldownMinutes?: number;
      concurrency?: number;
      batchSize?: number;
      maxRetryCount?: number;
    }
  ) {
    const log = await this.prisma.auditLog.findFirst({
      where: {
        id: logId,
        organizationId: orgId,
        action: 'publish_retry_bulk',
        resourceType: 'publish_job',
      },
      select: {
        id: true,
        detail: true,
      },
    });

    if (!log) {
      throw this.notFound('FACTORY_RETRY_HISTORY_NOT_FOUND', 'Retry history log not found');
    }

    const detail = (log.detail || {}) as Record<string, any>;
    const criteria = (detail.criteria || {}) as Record<string, any>;

    const replayInput = {
      errorCode: criteria.errorCode || undefined,
      maxRetryCount: Number(input?.maxRetryCount || criteria.maxRetryCount || 3),
      batchSize: Number(input?.batchSize || criteria.batchSize || 50),
      cooldownMinutes: Number(input?.cooldownMinutes ?? criteria.cooldownMinutes ?? 0),
      concurrency: Number(input?.concurrency || criteria.concurrency || 5),
      force: Boolean(input?.force ?? criteria.force ?? false),
    };

    return this.bulkRetryFailedPublishJobs(orgId, operatorId, replayInput);
  }

  async getPublishRetryHistoryDetail(orgId: string, logId: string) {
    const log = await this.prisma.auditLog.findFirst({
      where: {
        id: logId,
        organizationId: orgId,
        action: 'publish_retry_bulk',
        resourceType: 'publish_job',
      },
      select: {
        id: true,
        operator: true,
        createdAt: true,
        detail: true,
      },
    });

    if (!log) {
      throw this.notFound('FACTORY_RETRY_HISTORY_NOT_FOUND', 'Retry history log not found');
    }

    const detail = (log.detail || {}) as Record<string, any>;
    const criteria = (detail.criteria || {}) as Record<string, any>;
    const result = (detail.result || {}) as Record<string, any>;
    const selectedIds = Array.isArray(detail.selectedIds) ? detail.selectedIds : [];
    const failures = Array.isArray(result.failures) ? result.failures : [];

    return {
      id: log.id,
      operator: log.operator,
      createdAt: log.createdAt,
      mode: detail.mode || null,
      skippedByCooldown: Boolean(detail.skippedByCooldown),
      cooldownUntil: detail.cooldownUntil || null,
      criteria: {
        errorCode: criteria.errorCode || null,
        maxRetryCount: Number(criteria.maxRetryCount || 0),
        batchSize: Number(criteria.batchSize || 0),
        cooldownMinutes: Number(criteria.cooldownMinutes || 0),
        concurrency: Number(criteria.concurrency || 0),
        force: Boolean(criteria.force),
      },
      selectedCount: Number(detail.selectedCount || 0),
      selectedIds,
      result: {
        total: Number(result.total || 0),
        succeeded: Number(result.succeeded || 0),
        failed: Number(result.failed || 0),
        failures: failures.map((item: any) => ({
          publishJobId: item?.publishJobId || null,
          error: item?.error || null,
        })),
      },
    };
  }

  async previewRetryFailedPublishJobs(
    orgId: string,
    input?: {
      errorCode?: string;
      maxRetryCount?: number;
      batchSize?: number;
      cooldownMinutes?: number;
      concurrency?: number;
      force?: boolean;
    }
  ) {
    const maxRetryCount = Math.min(Math.max(input?.maxRetryCount || 3, 0), 10);
    const batchSize = Math.min(Math.max(input?.batchSize || 50, 1), 200);
    const cooldownMinutes = Math.min(Math.max(input?.cooldownMinutes || 0, 0), 1440);
    const concurrency = Math.min(Math.max(input?.concurrency || 5, 1), 20);
    const force = Boolean(input?.force);
    const criteriaErrorCode = input?.errorCode || null;

    if (cooldownMinutes > 0 && !force) {
      const cooldownFrom = new Date(Date.now() - cooldownMinutes * 60 * 1000);
      const recentBulkLog = await this.prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          action: 'publish_retry_bulk',
          resourceType: 'publish_job',
          createdAt: { gte: cooldownFrom },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentBulkLog) {
        const recentDetail = (recentBulkLog.detail || {}) as Record<string, any>;
        const recentMode = recentDetail?.mode;
        const recentErrorCode = recentDetail?.criteria?.errorCode || null;
        if (recentMode === 'failed_auto_retry' && recentErrorCode === criteriaErrorCode) {
          const cooldownUntil = new Date(
            recentBulkLog.createdAt.getTime() + cooldownMinutes * 60 * 1000
          );
          return {
            skipped: true,
            reason: 'COOLDOWN_ACTIVE',
            cooldownUntil: cooldownUntil.toISOString(),
            estimatedTotal: 0,
            candidateSampleIds: [] as string[],
            criteria: {
            errorCode: criteriaErrorCode,
            maxRetryCount,
            batchSize,
            cooldownMinutes,
            concurrency,
            force,
          },
        };
      }
      }
    }

    const jobs = await this.prisma.publishJob.findMany({
      where: {
        organizationId: orgId,
        status: 'FAILED',
        retryCount: { lt: maxRetryCount },
        ...(criteriaErrorCode ? { errorCode: criteriaErrorCode } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: batchSize,
    });

    return {
      skipped: false,
      reason: null as string | null,
      cooldownUntil: null as string | null,
      estimatedTotal: jobs.length,
      candidateSampleIds: jobs.slice(0, 10).map((job) => job.id),
      criteria: {
        errorCode: criteriaErrorCode,
        maxRetryCount,
        batchSize,
        cooldownMinutes,
        concurrency,
        force,
      },
    };
  }

  async bulkRetryFailedPublishJobs(
    orgId: string,
    operatorId: string,
    input?: {
      errorCode?: string;
      maxRetryCount?: number;
      limit?: number;
      batchSize?: number;
      cooldownMinutes?: number;
      concurrency?: number;
      force?: boolean;
    }
  ) {
    const maxRetryCount = Math.min(Math.max(input?.maxRetryCount || 3, 0), 10);
    const requestedBatchSize = input?.batchSize || input?.limit || 50;
    const limit = Math.min(Math.max(requestedBatchSize, 1), 200);
    const cooldownMinutes = Math.min(Math.max(input?.cooldownMinutes || 0, 0), 1440);
    const concurrency = Math.min(Math.max(input?.concurrency || 5, 1), 20);
    const force = Boolean(input?.force);
    const criteriaErrorCode = input?.errorCode || null;

    if (cooldownMinutes > 0 && !force) {
      const cooldownFrom = new Date(Date.now() - cooldownMinutes * 60 * 1000);
      const recentBulkLog = await this.prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          action: 'publish_retry_bulk',
          resourceType: 'publish_job',
          createdAt: { gte: cooldownFrom },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentBulkLog) {
        const recentDetail = (recentBulkLog.detail || {}) as Record<string, any>;
        const recentMode = recentDetail?.mode;
        const recentErrorCode = recentDetail?.criteria?.errorCode || null;
        if (recentMode === 'failed_auto_retry' && recentErrorCode === criteriaErrorCode) {
          const cooldownUntil = new Date(
            recentBulkLog.createdAt.getTime() + cooldownMinutes * 60 * 1000
          );
          await this.prisma.auditLog.create({
            data: {
              organizationId: orgId,
              operator: operatorId,
              action: 'publish_retry_bulk',
              resourceType: 'publish_job',
              resourceId: 'bulk',
              detail: {
                mode: 'failed_auto_retry',
                skippedByCooldown: true,
                blockedByLogId: recentBulkLog.id,
                criteria: {
                  errorCode: criteriaErrorCode,
                  maxRetryCount,
                  batchSize: limit,
                  cooldownMinutes,
                  concurrency,
                  force,
                },
                cooldownUntil: cooldownUntil.toISOString(),
                result: {
                  total: 0,
                  succeeded: 0,
                  failed: 0,
                },
              },
            },
          });

          return {
            total: 0,
            succeeded: 0,
            failed: 0,
            failures: [] as { publishJobId: string; error: string }[],
            skipped: true,
            reason: 'COOLDOWN_ACTIVE',
            cooldownUntil: cooldownUntil.toISOString(),
            criteria: {
              errorCode: criteriaErrorCode,
              maxRetryCount,
              batchSize: limit,
              cooldownMinutes,
              concurrency,
              force,
            },
          };
        }
      }
    }

    const jobs = await this.prisma.publishJob.findMany({
      where: {
        organizationId: orgId,
        status: 'FAILED',
        retryCount: { lt: maxRetryCount },
        ...(criteriaErrorCode ? { errorCode: criteriaErrorCode } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: limit,
    });

    if (jobs.length === 0) {
      await this.prisma.auditLog.create({
        data: {
          organizationId: orgId,
          operator: operatorId,
          action: 'publish_retry_bulk',
          resourceType: 'publish_job',
          resourceId: 'bulk',
          detail: {
            mode: 'failed_auto_retry',
            criteria: {
              errorCode: criteriaErrorCode,
              maxRetryCount,
              batchSize: limit,
              cooldownMinutes,
              concurrency,
              force,
            },
            selectedCount: 0,
            result: {
              total: 0,
              succeeded: 0,
              failed: 0,
            },
          },
        },
      });
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        failures: [] as { publishJobId: string; error: string }[],
        criteria: {
          errorCode: criteriaErrorCode,
          maxRetryCount,
          batchSize: limit,
          cooldownMinutes,
          concurrency,
          force,
        },
      };
    }

    const result = await this.bulkRetryPublishJobs(
      orgId,
      jobs.map((job) => job.id),
      operatorId,
      { concurrency }
    );

    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        operator: operatorId,
        action: 'publish_retry_bulk',
        resourceType: 'publish_job',
        resourceId: 'bulk',
        detail: {
          mode: 'failed_auto_retry',
          criteria: {
            errorCode: criteriaErrorCode,
            maxRetryCount,
            batchSize: limit,
            cooldownMinutes,
            concurrency,
            force,
          },
          selectedCount: jobs.length,
          selectedIds: jobs.map((job) => job.id),
          result: {
            total: result.total,
            succeeded: result.succeeded,
            failed: result.failed,
            failures: result.failures,
          },
        },
      },
    });

    return {
      ...result,
      selectedCount: jobs.length,
      selectedIds: jobs.map((job) => job.id),
      criteria: {
        errorCode: criteriaErrorCode,
        maxRetryCount,
        batchSize: limit,
        cooldownMinutes,
        concurrency,
        force,
      },
    };
  }
}
