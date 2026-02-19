import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { MaterialsQueueService } from '@gitroom/nestjs-libraries/materials/materials.queue.service';
import { MediaCrawlerService } from '@gitroom/nestjs-libraries/materials/materials.crawler.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { randomUUID } from 'crypto';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PublishStatus, ReviewStatus } from '@prisma/client';
import { ContentFactoryInput } from '@gitroom/orchestrator/workflows/content-factory.workflow';
import { AnalysisService } from '@gitroom/orchestrator/activities/analysis.service';

type GenerateDraftInput = ContentFactoryInput & {
  sourceContentIds: string[];
  analysisResult: unknown;
  regenerateHint?: string;
  existingDraftId?: string;
};

type PublishInput = {
  organizationId: string;
  draftId: string;
  integrationId: string;
  scheduleAt?: string;
};

@Injectable()
@Activity()
export class ContentFactoryActivity {
  constructor(
    private readonly materialsQueue: MaterialsQueueService,
    private readonly crawler: MediaCrawlerService,
    private readonly prisma: PrismaService,
    private readonly postActivity: PostActivity,
    private readonly integrationService: IntegrationService,
    private readonly analysisService: AnalysisService
  ) {}

  @ActivityMethod()
  async collectContent(input: ContentFactoryInput) {
    const jobId = `cf_${randomUUID()}`;
    await this.materialsQueue.enqueueJob(jobId, {
      orgId: input.organizationId,
      platform: input.collectParams.platform,
      keywords: input.collectParams.keywords,
      startPage: input.collectParams.startPage || 1,
      pageLimit: input.collectParams.pageLimit,
      queryHash: input.collectParams.queryHash,
    });

    const startedAt = Date.now();
    const timeoutMs = this.getCollectTimeoutMs();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.materialsQueue.getJobStatus(jobId);
      if (!status) {
        throw new Error('Materials job not found');
      }
      if (status.state === 'succeeded') {
        const result = await this.materialsQueue.getJobResult(jobId);
        if (!result?.resultPath) {
          // Queue state can briefly be succeeded before returnvalue is readable.
          await new Promise((resolve) =>
            setTimeout(resolve, Number(process.env.MATERIALS_POLL_INTERVAL_MS) || 3000)
          );
          continue;
        }
        const fileData = await this.crawler.readFile(
          result.resultPath,
          true,
          Number(process.env.MATERIALS_RESULT_LIMIT) || 200
        );
        const items = this.extractItems(fileData);
        const sourceContentIds: string[] = [];
        for (const item of items) {
          const created = await this.prisma.sourceContent.upsert({
            where: {
              organizationId_platform_externalId: {
                organizationId: input.organizationId,
                platform: input.collectParams.platform,
                externalId: this.getExternalId(item),
              },
            },
            create: {
              organizationId: input.organizationId,
              platform: input.collectParams.platform,
              externalId: this.getExternalId(item),
              title: this.getString(item, ['title']),
              content: this.getString(item, ['desc', 'content']),
              authorName: this.getString(item, ['nickname', 'author_name']),
              authorId: this.getString(item, ['user_id', 'author_id']),
              rawPayload: item as object,
              queryHash: input.collectParams.queryHash,
              jobId,
            },
            update: {
              title: this.getString(item, ['title']),
              content: this.getString(item, ['desc', 'content']),
              authorName: this.getString(item, ['nickname', 'author_name']),
              authorId: this.getString(item, ['user_id', 'author_id']),
              rawPayload: item as object,
              queryHash: input.collectParams.queryHash,
              jobId,
              deletedAt: null,
            },
          });
          sourceContentIds.push(created.id);

          const mediaUrls = this.collectMediaUrls(item);
          for (const url of mediaUrls) {
            await this.prisma.mediaAsset.create({
              data: {
                sourceContentId: created.id,
                type: url.type,
                url: url.value,
                localPath: url.value.startsWith('local:') ? url.value : null,
              },
            });
          }
        }

        await this.createAuditLog({
          organizationId: input.organizationId,
          operator: input.operatorId,
          action: 'collect',
          resourceType: 'source_content',
          resourceId: jobId,
          detail: {
            platform: input.collectParams.platform,
            keywords: input.collectParams.keywords,
            count: sourceContentIds.length,
          },
        });

        return {
          jobId,
          sourceContentIds,
          hasVideo: items.some((item) => this.collectMediaUrls(item).some((m) => m.type === 'video')),
        };
      }

      if (status.state === 'failed') {
        throw new Error(status.error || 'Materials job failed');
      }

      await new Promise((resolve) => setTimeout(resolve, Number(process.env.MATERIALS_POLL_INTERVAL_MS) || 3000));
    }

    throw new Error(`Materials collection timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  @ActivityMethod()
  async analyzeContent(input: { organizationId: string; sourceContentIds: string[] }) {
    const sourceContents = await this.prisma.sourceContent.findMany({
      where: {
        organizationId: input.organizationId,
        id: { in: input.sourceContentIds },
      },
      include: { mediaAssets: true },
    });
    const results = await this.analysisService.analyzeContents(
      sourceContents.map((content) => ({
        sourceContentId: content.id,
        title: content.title,
        content: content.content,
        mediaAssets: content.mediaAssets.map((asset) => ({
          type: asset.type,
          url: asset.url,
          localPath: asset.localPath,
        })),
      }))
    );

    for (const item of results) {
      await this.prisma.analysisResult.create({
        data: {
          sourceContentId: item.sourceContentId,
          type: item.type,
          modelUsed: item.modelUsed,
          confidence: item.confidence,
          result: item.result as object,
        },
      });
    }

    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: 'system',
      action: 'analyze',
      resourceType: 'source_content',
      resourceId: input.sourceContentIds.join(','),
      detail: {
        total: results.length,
        withVideo: sourceContents.filter((item) =>
          item.mediaAssets.some((asset) => asset.type === 'video')
        ).length,
      },
    });

    return results.map((item) => ({
      sourceContentId: item.sourceContentId,
      type: item.type,
      shortSummary:
        typeof item.result.shortSummary === 'string' ? (item.result.shortSummary as string) : '',
      visualSummary:
        typeof item.result.visualSummary === 'string' ? (item.result.visualSummary as string) : '',
      confidence: item.confidence,
    }));
  }

  @ActivityMethod()
  async generateDraft(input: GenerateDraftInput) {
    const sourceContents = await this.prisma.sourceContent.findMany({
      where: {
        organizationId: input.organizationId,
        id: { in: input.sourceContentIds },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    const content = this.buildDraftText(
      sourceContents.map((item) => item.content || item.title || '').filter(Boolean),
      input.productProfile,
      input.regenerateHint
    );
    const title = this.buildDraftTitle(sourceContents);
    const score = this.calculateDraftScore({
      title,
      content,
      sourceCount: sourceContents.length,
      hasProductProfile: Boolean(input.productProfile),
      hasRegenerateHint: Boolean(input.regenerateHint),
    });

    let draft;
    if (input.existingDraftId) {
      draft = await this.prisma.contentDraft.update({
        where: { id: input.existingDraftId },
        data: {
          title,
          content,
          score,
          productProfile: input.productProfile as object,
          sourceContentIds: JSON.stringify(input.sourceContentIds),
          reviewStatus: ReviewStatus.PENDING,
          reviewNote: input.regenerateHint || null,
        },
      });
    } else {
      draft = await this.prisma.contentDraft.create({
        data: {
          organizationId: input.organizationId,
          title,
          content,
          score,
          productProfile: input.productProfile as object,
          sourceContentIds: JSON.stringify(input.sourceContentIds),
          reviewStatus: ReviewStatus.PENDING,
          workflowId: input.workflowId || null,
        },
      });
    }

    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: input.operatorId,
      action: 'generate',
      resourceType: 'draft',
      resourceId: draft.id,
      detail: {
        sourceContentIds: input.sourceContentIds,
        regenerateHint: input.regenerateHint || null,
        score,
      },
    });

    return {
      id: draft.id,
      title: draft.title,
      content: draft.content,
      score: draft.score,
    };
  }

  @ActivityMethod()
  async updateDraftReviewState(input: {
    draftId: string;
    reviewStatus: ReviewStatus | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REGENERATING';
    reviewedBy?: string;
    reviewNote?: string;
  }) {
    await this.prisma.contentDraft.update({
      where: { id: input.draftId },
      data: {
        reviewStatus: input.reviewStatus as ReviewStatus,
        reviewedBy: input.reviewedBy || null,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote || null,
      },
    });
  }

  @ActivityMethod()
  async publishContent(input: PublishInput) {
    const draft = await this.prisma.contentDraft.findFirst({
      where: { id: input.draftId, organizationId: input.organizationId },
    });
    if (!draft) {
      throw new Error('Draft not found');
    }

    const integration = await this.integrationService.getIntegrationById(
      input.organizationId,
      input.integrationId
    );
    if (!integration) {
      throw new Error('Integration not found');
    }

    const sourceContentIds = this.parseSourceContentIds(draft.sourceContentIds);
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
    const isImmediatePublish =
      !input.scheduleAt || new Date(input.scheduleAt).getTime() <= Date.now();

    const idempotencyKey = `${input.integrationId}:${draft.id}:${input.scheduleAt || 'now'}`;
    const publishJob = await this.prisma.publishJob.upsert({
      where: { idempotencyKey },
      create: {
        organizationId: input.organizationId,
        contentDraftId: draft.id,
        integrationId: integration.id,
        scheduleAt: input.scheduleAt ? new Date(input.scheduleAt) : null,
        idempotencyKey,
        status: PublishStatus.PENDING,
      },
      update: {
        scheduleAt: input.scheduleAt ? new Date(input.scheduleAt) : null,
        status: PublishStatus.PENDING,
        errorCode: null,
        errorMessage: null,
      },
    });

    if (isImmediatePublish && postMedia.length === 0) {
      const message = 'FACTORY_MEDIA_REQUIRED: at least one image or video is required';
      await this.prisma.publishJob.update({
        where: { id: publishJob.id },
        data: {
          status: PublishStatus.FAILED,
          errorCode: 'FACTORY_MEDIA_REQUIRED',
          errorMessage: message,
          retryCount: { increment: 1 },
        },
      });
      await this.createAuditLog({
        organizationId: input.organizationId,
        operator: 'system',
        action: 'publish_precheck_failed',
        resourceType: 'publish_job',
        resourceId: publishJob.id,
        detail: {
          reason: 'FACTORY_MEDIA_REQUIRED',
          draftId: draft.id,
          integrationId: integration.id,
          scheduleAt: input.scheduleAt || null,
        },
      });
      throw new Error(message);
    }

    if (input.scheduleAt && new Date(input.scheduleAt).getTime() > Date.now()) {
      await this.prisma.publishJob.update({
        where: { id: publishJob.id },
        data: { status: PublishStatus.SCHEDULED },
      });
      return {
        status: PublishStatus.SCHEDULED,
        publishJobId: publishJob.id,
      };
    }

    try {
      await this.prisma.publishJob.update({
        where: { id: publishJob.id },
        data: { status: PublishStatus.PUBLISHING },
      });
      const responses = await this.postActivity.postSocial(integration as any, [
        {
          id: draft.id,
          content: draft.content || '',
          settings: '{}',
          image: JSON.stringify(postMedia),
        } as any,
      ]);
      const first = responses[0];

      await this.prisma.publishJob.update({
        where: { id: publishJob.id },
        data: {
          status: PublishStatus.PUBLISHED,
          externalPostId: first?.postId || null,
          publishedAt: new Date(),
        },
      });

      await this.createAuditLog({
        organizationId: input.organizationId,
        operator: 'system',
        action: 'publish',
        resourceType: 'publish_job',
        resourceId: publishJob.id,
        detail: {
          integrationId: integration.id,
          externalPostId: first?.postId || null,
          releaseURL: first?.releaseURL || null,
        },
      });

      return {
        status: PublishStatus.PUBLISHED,
        publishJobId: publishJob.id,
        externalPostId: first?.postId || null,
        releaseURL: first?.releaseURL || null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'publish failed';
      await this.prisma.publishJob.update({
        where: { id: publishJob.id },
        data: {
          status: PublishStatus.FAILED,
          errorMessage: message,
          retryCount: { increment: 1 },
        },
      });
      throw new Error(message);
    }
  }

  @ActivityMethod()
  async markWorkflowFailed(input: {
    organizationId: string;
    workflowId: string;
    reason: string;
  }) {
    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: 'system',
      action: 'workflow_failed',
      resourceType: 'workflow',
      resourceId: input.workflowId || 'unknown',
      detail: { reason: input.reason },
    });
  }

  private extractItems(payload: unknown) {
    if (Array.isArray(payload)) {
      return payload as Record<string, unknown>[];
    }
    if (
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      Array.isArray((payload as { data?: unknown[] }).data)
    ) {
      return ((payload as { data?: unknown[] }).data || []) as Record<string, unknown>[];
    }
    return [];
  }

  private getExternalId(item: Record<string, unknown>) {
    const candidate = this.getString(item, [
      'note_id',
      'aweme_id',
      'id',
      'post_id',
      'video_id',
    ]);
    return candidate || randomUUID();
  }

  private getString(item: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private collectMediaUrls(item: Record<string, unknown>) {
    const urls: { type: string; value: string }[] = [];
    const addValue = (value: unknown, type: string) => {
      if (typeof value === 'string' && value.trim()) {
        urls.push({ type, value: value.trim() });
      }
    };

    const pushMany = (value: unknown, type: string) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => addValue(entry, type));
      } else if (typeof value === 'string') {
        value
          .split(',')
          .map((itemValue) => itemValue.trim())
          .filter(Boolean)
          .forEach((entry) => addValue(entry, type));
      }
    };

    pushMany(item.image_list, 'image');
    pushMany(item.images, 'image');
    pushMany(item.image_urls, 'image');
    addValue(item.cover, 'image');
    addValue(item.cover_url, 'image');
    addValue(item.video_cover, 'image');
    addValue(item.video_url, 'video');
    return urls;
  }

  private buildDraftTitle(sourceContents: { title: string | null }[]) {
    const title = sourceContents.find((item) => item.title)?.title;
    if (title) {
      return `改写｜${title.slice(0, 32)}`;
    }
    return `内容草稿 ${new Date().toISOString().slice(0, 10)}`;
  }

  private calculateDraftScore(input: {
    title: string;
    content: string;
    sourceCount: number;
    hasProductProfile: boolean;
    hasRegenerateHint: boolean;
  }) {
    let score = 50;
    const titleLength = input.title.trim().length;
    const contentLength = input.content.trim().length;

    if (titleLength >= 12 && titleLength <= 36) score += 12;
    else if (titleLength >= 8) score += 6;

    if (contentLength >= 180 && contentLength <= 1200) score += 18;
    else if (contentLength >= 120) score += 10;

    if (input.sourceCount >= 3) score += 12;
    else if (input.sourceCount > 0) score += 6;

    if (input.hasProductProfile) score += 8;
    if (input.content.includes('【标题】') && input.content.includes('【正文】')) score += 6;
    if (input.hasRegenerateHint) score -= 4;

    return Math.max(0, Math.min(100, Number(score.toFixed(1))));
  }

  private buildDraftText(
    sourceContents: string[],
    productProfile?: Record<string, unknown>,
    regenerateHint?: string
  ) {
    const productLine = productProfile
      ? `产品画像：${JSON.stringify(productProfile)}`
      : '产品画像：未提供';
    const hint = regenerateHint ? `审核意见：${regenerateHint}` : '';
    const source = sourceContents.slice(0, 3).join('\n');
    return [
      '【标题】',
      '真实体验分享：3个关键细节帮你快速判断是否适合',
      '',
      '【正文】',
      productLine,
      hint,
      '',
      '核心观点：',
      '1) 先说结论，给用户一个明确选择依据。',
      '2) 用场景化描述替代空泛术语。',
      '3) 给出可执行的下一步动作。',
      '',
      '素材参考：',
      source || '暂无',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private parseSourceContentIds(value: string | null | undefined) {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((item) => typeof item === 'string' && item.trim().length > 0);
    } catch {
      return [];
    }
  }

  private buildPostMedia(
    assets: Array<{
      id: string;
      type: string;
      url: string;
      localPath: string | null;
    }>
  ) {
    return assets
      .map((asset) => {
        const rawPath = asset.localPath || asset.url || '';
        const normalizedPath = this.normalizeMediaPath(rawPath);
        if (!normalizedPath) {
          return null;
        }
        return {
          id: asset.id,
          path: normalizedPath,
        };
      })
      .filter((item): item is { id: string; path: string } => Boolean(item));
  }

  private normalizeMediaPath(pathValue: string) {
    if (!pathValue) {
      return '';
    }
    if (/^https?:\/\//i.test(pathValue)) {
      return pathValue;
    }
    if (pathValue.startsWith('local:')) {
      return `materials/${pathValue.replace('local:', '')}`;
    }
    return pathValue;
  }

  private async createAuditLog(input: {
    organizationId: string;
    operator: string;
    action: string;
    resourceType: string;
    resourceId: string;
    detail?: Record<string, unknown>;
  }) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        operator: input.operator,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        detail: (input.detail || {}) as object,
      },
    });
  }

  private getCollectTimeoutMs() {
    const maxRuntimeSeconds = Number(process.env.MATERIALS_MAX_RUNTIME_SECONDS || 0);
    if (Number.isFinite(maxRuntimeSeconds) && maxRuntimeSeconds > 0) {
      return maxRuntimeSeconds * 1000;
    }

    const queueTimeoutMs = Number(process.env.MATERIALS_JOB_TIMEOUT_MS || 0);
    if (Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0) {
      return queueTimeoutMs;
    }

    return 30 * 60 * 1000;
  }
}
