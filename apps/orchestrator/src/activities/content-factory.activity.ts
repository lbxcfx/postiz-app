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
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';

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

type GenerateVideoInput = {
  organizationId: string;
  operatorId: string;
  draftId: string;
  sourceContentIds: string[];
  strategy:
    | 'auto'
    | 'qwen-text-to-video'
    | 'qwen-image-to-video'
    | 'qwen-image-to-video-first-last';
};

@Injectable()
@Activity()
export class ContentFactoryActivity {
  private readonly storage = UploadFactory.createStorage();

  constructor(
    private readonly materialsQueue: MaterialsQueueService,
    private readonly crawler: MediaCrawlerService,
    private readonly prisma: PrismaService,
    private readonly postActivity: PostActivity,
    private readonly integrationService: IntegrationService,
    private readonly analysisService: AnalysisService,
    private readonly mediaService: MediaService
  ) {}

  @ActivityMethod()
  async collectContent(input: ContentFactoryInput) {
    if (Array.isArray(input.sourceContentIds) && input.sourceContentIds.length > 0) {
      const sourceContents = await this.prisma.sourceContent.findMany({
        where: {
          organizationId: input.organizationId,
          id: { in: input.sourceContentIds },
          deletedAt: null,
        },
        include: { mediaAssets: true },
      });
      if (sourceContents.length === 0) {
        throw new Error('No valid source content found');
      }

      const sourceContentIds = sourceContents.map((item) => item.id);
      await this.createAuditLog({
        organizationId: input.organizationId,
        operator: input.operatorId,
        action: 'collect_reuse',
        resourceType: 'source_content',
        resourceId: sourceContentIds.join(','),
        detail: {
          count: sourceContentIds.length,
          generationMode: input.generationMode || 'text',
          videoStrategy: input.videoStrategy || 'auto',
        },
      });

      return {
        jobId: `cf_reuse_${randomUUID()}`,
        sourceContentIds,
        hasVideo: sourceContents.some((item) =>
          item.mediaAssets.some((asset) => asset.type === 'video')
        ),
      };
    }

    if (!input.collectParams?.platform || !input.collectParams?.keywords) {
      throw new Error('collectParams.platform and collectParams.keywords are required');
    }

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

    const analysisRows = await this.prisma.analysisResult.findMany({
      where: {
        sourceContentId: { in: input.sourceContentIds },
        type: { in: ['material_video_analysis_v1', 'video_analysis'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    });
    const generationBrief = this.buildGenerationBrief(sourceContents, analysisRows, {
      generationMode: input.generationMode || 'text',
      videoStrategy: input.videoStrategy || 'auto',
    });
    const mergedProductProfile = this.mergeProductProfile(input.productProfile, generationBrief);

    const sourceTexts = sourceContents
      .map((item) => item.content || item.title || '')
      .filter(Boolean);
    const content = await this.generateDraftByQwen(
      sourceTexts,
      mergedProductProfile,
      input.regenerateHint,
      generationBrief
    );
    const title = this.buildDraftTitle(sourceContents, generationBrief.hotKeywords);
    const score = this.calculateDraftScore({
      title,
      content,
      sourceCount: sourceContents.length,
      hasProductProfile: Boolean(mergedProductProfile),
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
          productProfile: mergedProductProfile as object,
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
          productProfile: mergedProductProfile as object,
          sourceContentIds: JSON.stringify(input.sourceContentIds),
          reviewStatus: ReviewStatus.PENDING,
          workflowId: input.workflowId || null,
        },
      });
    }

    const generatedImages = await this.generateDraftImages({
      organizationId: input.organizationId,
      sourceContentIds: input.sourceContentIds,
      title,
      content,
      imageCount: input.imageCount,
      generationMode: input.generationMode || 'text',
      generationBrief,
      operatorId: input.operatorId,
      productProfile: mergedProductProfile,
    });

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
        generatedImages,
        generationBrief,
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
  async generateVideoAssets(input: GenerateVideoInput) {
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
    });
    if (!org) {
      throw new Error('Organization not found');
    }
    const draft = await this.prisma.contentDraft.findFirst({
      where: {
        id: input.draftId,
        organizationId: input.organizationId,
        deletedAt: null,
      },
    });
    if (!draft) {
      throw new Error('Draft not found');
    }

    const sourceContents = await this.prisma.sourceContent.findMany({
      where: {
        organizationId: input.organizationId,
        id: { in: input.sourceContentIds },
        deletedAt: null,
      },
      include: { mediaAssets: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    if (sourceContents.length === 0) {
      throw new Error('No source content for video generation');
    }

    const imageCandidates = Array.from(
      new Set(
        sourceContents
          .flatMap((item) => item.mediaAssets)
          .filter((asset) => asset.type === 'image')
          .map((asset) => this.normalizeMediaPath(asset.localPath || asset.url || ''))
          .filter(Boolean)
      )
    );

    const strategies =
      input.strategy === 'auto'
        ? ([
            'qwen-image-to-video-first-last',
            'qwen-image-to-video',
            'qwen-text-to-video',
          ] as const)
        : ([input.strategy] as const);
    const targetSourceId = sourceContents[0].id;
    const prompt = this.buildVideoPrompt(
      draft.title || '',
      draft.content || '',
      sourceContents.map((item) => item.content || item.title || '').filter(Boolean)
    );

    const errors: string[] = [];
    for (const strategy of strategies) {
      try {
        const media = await this.runVideoStrategy({
          strategy,
          org,
          prompt,
          imageCandidates,
          sourceContentId: targetSourceId,
        });

        await this.prisma.mediaAsset.create({
          data: {
            sourceContentId: targetSourceId,
            type: 'video',
            url: media.path,
            localPath: null,
          },
        });

        await this.createAuditLog({
          organizationId: input.organizationId,
          operator: input.operatorId,
          action: 'generate_video',
          resourceType: 'draft',
          resourceId: input.draftId,
          detail: {
            strategy,
            sourceContentId: targetSourceId,
            mediaId: media.id,
            mediaPath: media.path,
          },
        });

        return {
          ok: true,
          strategy,
          sourceContentId: targetSourceId,
          mediaId: media.id,
          mediaPath: media.path,
          errors,
        };
      } catch (error) {
        errors.push(`${strategy}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: input.operatorId,
      action: 'generate_video_failed',
      resourceType: 'draft',
      resourceId: input.draftId,
      detail: {
        strategy: input.strategy,
        errors,
      },
    });

    return {
      ok: false,
      strategy: input.strategy,
      errors,
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

  private buildDraftTitle(
    sourceContents: { title: string | null }[],
    hotKeywords: string[] = []
  ) {
    const title = sourceContents.find((item) => item.title)?.title;
    const keyword = hotKeywords.find((item) => item && item.length >= 2) || '';
    if (keyword && title) {
      return `改写｜${keyword}：${title.slice(0, 24)}`;
    }
    if (title) {
      return `改写｜${title.slice(0, 32)}`;
    }
    if (keyword) {
      return `改写｜${keyword}实战指南`;
    }
    return `内容草稿 ${new Date().toISOString().slice(0, 10)}`;
  }

  private mergeProductProfile(
    profile: Record<string, unknown> | undefined,
    brief: {
      mode: string;
      strategy: string;
      hotKeywords: string[];
      styleTags: string[];
      optimizationSuggestions: string[];
      summary: string;
    }
  ) {
    return {
      ...(profile || {}),
      generationBrief: brief,
    };
  }

  private buildGenerationBrief(
    sourceContents: Array<{ id: string; title: string | null; content: string | null }>,
    analysisRows: Array<{ sourceContentId: string; result: unknown }>,
    input: { generationMode: string; videoStrategy: string }
  ) {
    const bySource = new Map<string, any>();
    for (const row of analysisRows) {
      if (!bySource.has(row.sourceContentId)) {
        bySource.set(row.sourceContentId, row.result || {});
      }
    }

    const hotKeywords: string[] = [];
    const styleTags: string[] = [];
    const optimizationSuggestions: string[] = [];
    const scores: number[] = [];

    for (const source of sourceContents) {
      const raw = bySource.get(source.id) || {};
      const payload = typeof raw === 'object' && raw ? raw : {};
      const analysis = (payload as any).analysis || payload;
      const tagLayer = (analysis as any)?.tagLayer || {};
      const scoreLayer = (analysis as any)?.scoreLayer || {};
      const summaryLayer = (payload as any)?.summaryLayer || {};

      (Array.isArray(tagLayer.hotKeywords) ? tagLayer.hotKeywords : [])
        .filter((item: unknown) => typeof item === 'string' && item.trim())
        .forEach((item: string) => hotKeywords.push(item.trim()));
      (Array.isArray(tagLayer.styleTags) ? tagLayer.styleTags : [])
        .filter((item: unknown) => typeof item === 'string' && item.trim())
        .forEach((item: string) => styleTags.push(item.trim()));
      (Array.isArray(summaryLayer.optimizationSuggestions)
        ? summaryLayer.optimizationSuggestions
        : []
      )
        .filter((item: unknown) => typeof item === 'string' && item.trim())
        .forEach((item: string) => optimizationSuggestions.push(item.trim()));

      const overall = Number(scoreLayer.overallScore || 0);
      if (Number.isFinite(overall) && overall > 0) {
        scores.push(overall);
      }
    }

    const normalizedKeywords = Array.from(new Set(hotKeywords)).slice(0, 8);
    const normalizedStyles = Array.from(new Set(styleTags)).slice(0, 6);
    const normalizedSuggestions = Array.from(new Set(optimizationSuggestions)).slice(0, 5);
    const avgScore = scores.length
      ? Number((scores.reduce((sum, item) => sum + item, 0) / scores.length).toFixed(1))
      : null;

    return {
      mode: input.generationMode,
      strategy: input.videoStrategy,
      hotKeywords: normalizedKeywords,
      styleTags: normalizedStyles,
      optimizationSuggestions: normalizedSuggestions,
      averageScore: avgScore,
      summary: this.shortSummary(
        sourceContents.map((item) => item.title || item.content || '').join(' ')
      ),
    };
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
    regenerateHint?: string,
    generationBrief?: {
      mode: string;
      strategy: string;
      hotKeywords: string[];
      styleTags: string[];
      optimizationSuggestions: string[];
      averageScore: number | null;
    }
  ) {
    const productLine = productProfile
      ? `产品画像：${JSON.stringify(productProfile)}`
      : '产品画像：未提供';
    const hint = regenerateHint ? `审核意见：${regenerateHint}` : '';
    const keywords =
      generationBrief?.hotKeywords && generationBrief.hotKeywords.length
        ? `爆款关键词：${generationBrief.hotKeywords.slice(0, 6).join('、')}`
        : '爆款关键词：无';
    const styles =
      generationBrief?.styleTags && generationBrief.styleTags.length
        ? `风格标签：${generationBrief.styleTags.slice(0, 4).join(' / ')}`
        : '风格标签：教程拆解 / 清单种草';
    const optimizations =
      generationBrief?.optimizationSuggestions && generationBrief.optimizationSuggestions.length
        ? generationBrief.optimizationSuggestions.slice(0, 3)
        : ['开场3秒先给结论', '增加对比细节与可执行步骤', '结尾加入明确CTA'];
    const source = sourceContents.slice(0, 3).join('\n');
    return [
      '【标题】',
      '真实体验分享：3个关键细节帮你快速判断是否适合',
      '',
      '【正文】',
      productLine,
      hint,
      keywords,
      styles,
      generationBrief?.averageScore !== null && generationBrief?.averageScore !== undefined
        ? `爆款均分：${generationBrief.averageScore}`
        : '',
      `生成模式：${generationBrief?.mode || 'text'} / 视频策略：${generationBrief?.strategy || 'auto'}`,
      '',
      '核心观点：',
      '1) 先说结论，给用户一个明确选择依据。',
      '2) 用场景化描述替代空泛术语。',
      '3) 给出可执行的下一步动作。',
      '',
      '优化建议：',
      ...optimizations.map((item, index) => `${index + 1}) ${item}`),
      '',
      '素材参考：',
      source || '暂无',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private resolveQwenApiKey() {
    return process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  }

  private resolveQwenBaseUrl() {
    return (
      process.env.QWEN_BASE_URL ||
      process.env.QWEN_API_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/$/, '');
  }

  private async generateDraftByQwen(
    sourceContents: string[],
    productProfile?: Record<string, unknown>,
    regenerateHint?: string,
    generationBrief?: {
      mode: string;
      strategy: string;
      hotKeywords: string[];
      styleTags: string[];
      optimizationSuggestions: string[];
      averageScore: number | null;
    }
  ) {
    const fallback = this.buildDraftText(
      sourceContents,
      productProfile,
      regenerateHint,
      generationBrief
    );
    const apiKey = this.resolveQwenApiKey();
    if (!apiKey) {
      return fallback;
    }

    const model = process.env.QWEN_MODEL || 'qwen3-max';
    const endpoint = `${this.resolveQwenBaseUrl()}/chat/completions`;
    const prompt = [
      '请基于爆款素材分析结果生成中文图文草稿，结构必须包含【标题】与【正文】。',
      '正文要求：开场结论 + 3个要点 + 明确CTA；语气自然、可执行。',
      `生成模式：${generationBrief?.mode || 'text'}`,
      `视频策略：${generationBrief?.strategy || 'auto'}`,
      `关键词：${(generationBrief?.hotKeywords || []).join('、') || '无'}`,
      `风格：${(generationBrief?.styleTags || []).join(' / ') || '教程拆解'}`,
      `优化建议：${(generationBrief?.optimizationSuggestions || []).join('；') || '无'}`,
      `产品画像：${productProfile ? JSON.stringify(productProfile) : '未提供'}`,
      `审核意见：${regenerateHint || '无'}`,
      '素材参考：',
      sourceContents.slice(0, 5).join('\n'),
    ].join('\n');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.6,
          messages: [
            {
              role: 'system',
              content: '你是专业的新媒体图文写作助手，只输出最终草稿正文。',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });
      if (!response.ok) {
        return fallback;
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload?.choices?.[0]?.message?.content?.trim() || '';
      if (!content) {
        return fallback;
      }
      if (!content.includes('【标题】') || !content.includes('【正文】')) {
        return fallback;
      }
      return content;
    } catch {
      return fallback;
    }
  }

  private normalizeImageCount(imageCount: number | undefined, generationMode: string) {
    const parsed = Number(imageCount || 0);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(0, Math.min(Math.round(parsed), 12));
    }
    if (generationMode === 'video') {
      return 0;
    }
    if (generationMode === 'hybrid') {
      return 4;
    }
    return 3;
  }

  private buildDraftImagePrompts(input: {
    title: string;
    content: string;
    generationBrief: {
      hotKeywords: string[];
      styleTags: string[];
      optimizationSuggestions: string[];
    };
    productProfile?: Record<string, unknown>;
    isXhs: boolean;
    imageCount: number;
  }) {
    const base = [
      input.title ? `主题：${input.title}` : '',
      `正文摘要：${this.shortSummary(input.content)}`,
      input.generationBrief.hotKeywords.length
        ? `关键词：${input.generationBrief.hotKeywords.slice(0, 5).join('、')}`
        : '',
      input.generationBrief.styleTags.length
        ? `风格：${input.generationBrief.styleTags.slice(0, 4).join(' / ')}`
        : '',
      input.productProfile ? `品牌画像：${JSON.stringify(input.productProfile)}` : '',
      input.isXhs
        ? '平台要求：小红书图文配图，强调真实感、清晰主体、适合手机浏览。'
        : '平台要求：社媒图文配图，主体明确，信息密度高。',
      '画面要求：竖版 9:16，真实自然，无水印、无Logo、无文字。',
    ]
      .filter(Boolean)
      .join('\n');

    return Array.from({ length: input.imageCount }).map((_, index) => {
      const scene =
        index === 0
          ? '首图/封面'
          : index === input.imageCount - 1
            ? '结尾图/收束图'
            : `正文配图${index + 1}`;
      return `${base}\n当前图位：${scene}。请仅返回可用于生成图片的最终画面内容。`;
    });
  }

  private async saveGeneratedImageAsset(input: {
    sourceContentId: string;
    url: string;
  }) {
    let stableUrl = input.url;
    if (/^https?:\/\//i.test(input.url)) {
      try {
        // Persist remote signed URL to our storage so preview links do not expire quickly.
        stableUrl = await this.storage.uploadSimple(input.url);
      } catch (error) {
        console.warn(
          '[Factory] uploadSimple failed, keep original image url:',
          error instanceof Error ? error.message : 'unknown error'
        );
      }
    }

    const asset = await this.prisma.mediaAsset.create({
      data: {
        sourceContentId: input.sourceContentId,
        type: 'image',
        url: stableUrl,
        localPath: null,
      },
    });
    return {
      id: asset.id,
      path: this.normalizeMediaPath(asset.localPath || asset.url || ''),
    };
  }

  private async generateFrameImageForVideo(input: {
    organizationId: string;
    org: { id: string; isTrailing: boolean };
    sourceContentId: string;
    prompt: string;
    purpose: 'video_first_frame' | 'video_last_frame';
  }) {
    const imageUrl = await this.mediaService.generateImage(
      input.prompt,
      input.org as any,
      true
    );
    await this.saveGeneratedImageAsset({
      sourceContentId: input.sourceContentId,
      url: imageUrl,
    });
    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: 'system',
      action: 'generate_image',
      resourceType: 'source_content',
      resourceId: input.sourceContentId,
      detail: {
        purpose: input.purpose,
        prompt: this.shortSummary(input.prompt),
      },
    });
    return imageUrl;
  }

  private async generateDraftImages(input: {
    organizationId: string;
    sourceContentIds: string[];
    title: string;
    content: string;
    imageCount?: number;
    generationMode: string;
    generationBrief: {
      hotKeywords: string[];
      styleTags: string[];
      optimizationSuggestions: string[];
    };
    operatorId: string;
    productProfile?: Record<string, unknown>;
  }) {
    const imageCount = this.normalizeImageCount(input.imageCount, input.generationMode);
    if (imageCount <= 0 || input.sourceContentIds.length === 0) {
      return {
        requested: imageCount,
        generated: 0,
        failed: 0,
        isXhs: false,
      };
    }

    const sourceContents = await this.prisma.sourceContent.findMany({
      where: {
        organizationId: input.organizationId,
        id: { in: input.sourceContentIds },
        deletedAt: null,
      },
      select: {
        id: true,
        platform: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const targetSourceId = sourceContents[0]?.id || input.sourceContentIds[0];
    const isXhs = sourceContents.some((item) => item.platform === 'xhs');
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
    });
    if (!org || !targetSourceId) {
      return {
        requested: imageCount,
        generated: 0,
        failed: imageCount,
        isXhs,
      };
    }

    const prompts = this.buildDraftImagePrompts({
      title: input.title,
      content: input.content,
      generationBrief: input.generationBrief,
      productProfile: input.productProfile,
      isXhs,
      imageCount,
    });

    const generated: Array<{ id: string; path: string }> = [];
    const errors: string[] = [];
    let failed = 0;
    for (const prompt of prompts) {
      try {
        const imageUrl = await this.mediaService.generateImage(prompt, org as any, true);
        const asset = await this.saveGeneratedImageAsset({
          sourceContentId: targetSourceId,
          url: imageUrl,
        });
        generated.push(asset);
      } catch (error) {
        failed += 1;
        if (errors.length < 5) {
          const message = error instanceof Error ? error.message : 'unknown error';
          errors.push(message.length > 280 ? `${message.slice(0, 277)}...` : message);
        }
      }
    }

    await this.createAuditLog({
      organizationId: input.organizationId,
      operator: input.operatorId,
      action: 'generate_image',
      resourceType: 'source_content',
      resourceId: targetSourceId,
      detail: {
        requested: imageCount,
        generated: generated.length,
        failed,
        isXhs,
        ...(errors.length > 0 ? { errors } : {}),
      },
    });

    return {
      requested: imageCount,
      generated: generated.length,
      failed,
      isXhs,
      assets: generated,
      errors,
    };
  }

  private shortSummary(text: string) {
    const compact = (text || '').replace(/\s+/g, ' ').trim();
    if (!compact) {
      return '暂无摘要';
    }
    return compact.slice(0, 96);
  }

  private buildVideoPrompt(title: string, content: string, sourceContents: string[]) {
    return [
      title ? `主题：${title}` : '主题：爆款内容改写',
      '请生成一条9:16短视频，保持强开场、信息密度和明确CTA。',
      `正文要点：${this.shortSummary(content)}`,
      `素材线索：${this.shortSummary(sourceContents.slice(0, 3).join(' '))}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async runVideoStrategy(input: {
    strategy:
      | 'qwen-text-to-video'
      | 'qwen-image-to-video'
      | 'qwen-image-to-video-first-last';
    org: { id: string; isTrailing: boolean };
    prompt: string;
    imageCandidates: string[];
    sourceContentId: string;
  }) {
    const urls = input.imageCandidates
      .filter((item) => /^https?:\/\//i.test(item))
      .slice(0, 4);

    if (input.strategy === 'qwen-text-to-video') {
      return this.mediaService.generateVideo(input.org as any, {
        type: 'qwen-video',
        output: 'vertical',
        customParams: {
          mode: 'text-to-video',
          prompt: input.prompt,
        },
      } as any);
    }

    if (input.strategy === 'qwen-image-to-video') {
      let imageUrl = urls[0];
      if (!imageUrl) {
        imageUrl = await this.generateFrameImageForVideo({
          organizationId: input.org.id,
          org: input.org,
          sourceContentId: input.sourceContentId,
          prompt: `${input.prompt}\n请生成短视频首帧画面，竖屏9:16，主体清晰、适合口播封面。`,
          purpose: 'video_first_frame',
        });
      }
      return this.mediaService.generateVideo(input.org as any, {
        type: 'qwen-video',
        output: 'vertical',
        customParams: {
          mode: 'image-to-video',
          prompt: input.prompt,
          imageUrl,
        },
      } as any);
    }

    let firstFrameUrl = urls[0];
    let lastFrameUrl = urls[1];
    if (!firstFrameUrl) {
      firstFrameUrl = await this.generateFrameImageForVideo({
        organizationId: input.org.id,
        org: input.org,
        sourceContentId: input.sourceContentId,
        prompt: `${input.prompt}\n请生成短视频首帧画面，竖屏9:16，视觉冲击强，突出核心主体。`,
        purpose: 'video_first_frame',
      });
    }
    if (!lastFrameUrl) {
      lastFrameUrl = await this.generateFrameImageForVideo({
        organizationId: input.org.id,
        org: input.org,
        sourceContentId: input.sourceContentId,
        prompt: `${input.prompt}\n请生成短视频尾帧画面，竖屏9:16，画面有收束感，适合CTA结尾。`,
        purpose: 'video_last_frame',
      });
    }
    return this.mediaService.generateVideo(input.org as any, {
      type: 'qwen-video',
      output: 'vertical',
      customParams: {
        mode: 'image-to-video-first-last',
        prompt: input.prompt,
        firstFrameUrl,
        lastFrameUrl,
      },
    } as any);
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
