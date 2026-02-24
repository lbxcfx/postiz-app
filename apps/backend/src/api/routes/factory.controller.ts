import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  FactoryService,
  StartCreationInput,
  StartFactoryWorkflowInput,
} from '@gitroom/backend/services/factory/factory.service';
import { Response } from 'express';

@ApiTags('Factory')
@Controller('/factory')
export class FactoryController {
  constructor(private readonly factory: FactoryService) {}

  @Post('/workflows/start')
  async startWorkflow(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Query('idempotencyKey') idempotencyKeyQuery: string | undefined,
    @Body() body: Omit<StartFactoryWorkflowInput, 'operatorId'>
  ) {
    return this.factory.startWorkflow(org.id, {
      ...body,
      operatorId: user.id,
      idempotencyKey:
        body.idempotencyKey || idempotencyKeyHeader || idempotencyKeyQuery,
    });
  }

  @Post('/creation/start')
  async startCreation(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Query('idempotencyKey') idempotencyKeyQuery: string | undefined,
    @Body() body: Omit<StartCreationInput, 'operatorId'>
  ) {
    return this.factory.startCreation(org.id, {
      ...body,
      operatorId: user.id,
      idempotencyKey:
        body.idempotencyKey || idempotencyKeyHeader || idempotencyKeyQuery,
    });
  }

  @Get('/creation/tasks')
  async getCreationTasks(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string
  ) {
    return this.factory.getCreationTasks(org.id, {
      limit: Number(limit || 20),
    });
  }

  @Get('/creation/tasks/:workflowId')
  async getCreationTaskDetail(
    @GetOrgFromRequest() org: Organization,
    @Param('workflowId') workflowId: string
  ) {
    return this.factory.getCreationTaskDetail(org.id, workflowId);
  }

  @Post('/creation/tasks/:workflowId/schedule')
  async scheduleCreationTask(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
      scheduleAt: string;
      mediaType?: 'image' | 'video';
      integrationId?: string;
      title?: string;
      tags?: string[];
    }
  ) {
    return this.factory.scheduleCreationTask(org.id, workflowId, {
      operatorId: user.id,
      scheduleAt: body.scheduleAt,
      mediaType: body.mediaType,
      integrationId: body.integrationId,
      title: body.title,
      tags: body.tags,
    });
  }

  @Get('/creation/n8n-workflows')
  async getCreationN8nWorkflows() {
    return this.factory.listCreationN8nWorkflows();
  }

  @Get('/creation/sources')
  async getCreationSources(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string
  ) {
    return this.factory.getSourceContents(org.id, Number(limit || 80));
  }

  @Get('/workflows/:workflowId')
  async getWorkflowStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('workflowId') workflowId: string
  ) {
    return this.factory.getWorkflowStatus(org.id, workflowId);
  }

  @Get('/workflows/:workflowId/draft')
  async getWorkflowDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('workflowId') workflowId: string
  ) {
    return this.factory.getWorkflowDraft(org.id, workflowId);
  }

  @Post('/workflows/status/batch')
  async getWorkflowStatuses(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { workflowIds: string[] }
  ) {
    return this.factory.getWorkflowStatuses(org.id, body.workflowIds || []);
  }

  @Post('/drafts/:draftId/review')
  async reviewDraft(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('draftId') draftId: string,
    @Body() body: { decision: 'approve' | 'reject'; note?: string }
  ) {
    return this.factory.reviewDraft(org.id, draftId, {
      decision: body.decision,
      note: body.note,
      operatorId: user.id,
    });
  }

  @Post('/drafts/review/bulk')
  async bulkReviewDrafts(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { draftIds: string[]; decision: 'approve' | 'reject'; note?: string }
  ) {
    return this.factory.bulkReviewDrafts(org.id, {
      draftIds: body.draftIds || [],
      decision: body.decision,
      note: body.note,
      operatorId: user.id,
    });
  }

  @Post('/workflows/:workflowId/cancel')
  async cancelWorkflow(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('workflowId') workflowId: string
  ) {
    return this.factory.cancelWorkflow(org.id, workflowId, user.id);
  }

  @Post('/workflows/cancel/bulk')
  async bulkCancelWorkflows(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { workflowIds: string[] }
  ) {
    return this.factory.bulkCancelWorkflows(org.id, body.workflowIds || [], user.id);
  }

  @Get('/workflows/paged')
  async getWorkflowsPaged(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: 'ALL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED',
    @Query('sortBy') sortBy?: 'createdAt' | 'updatedAt',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    return this.factory.getWorkflowsPaged(org.id, {
      page: Number(page || 1),
      pageSize: Number(pageSize || 20),
      status: status || 'ALL',
      sortBy,
      sortOrder,
    });
  }

  @Post('/publish-jobs/:publishJobId/retry')
  async retryPublishJob(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('publishJobId') publishJobId: string
  ) {
    return this.factory.retryPublishJob(org.id, publishJobId, user.id);
  }

  @Post('/publish-jobs/retry/bulk')
  async bulkRetryPublishJobs(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { publishJobIds: string[]; concurrency?: number }
  ) {
    return this.factory.bulkRetryPublishJobs(org.id, body.publishJobIds || [], user.id, {
      concurrency: Number(body?.concurrency || 5),
    });
  }

  @Post('/publish-jobs/retry/failed')
  async bulkRetryFailedPublishJobs(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body()
    body?: {
      errorCode?: string;
      maxRetryCount?: number;
      limit?: number;
      batchSize?: number;
      cooldownMinutes?: number;
      concurrency?: number;
      force?: boolean;
    }
  ) {
    return this.factory.bulkRetryFailedPublishJobs(org.id, user.id, body || {});
  }

  @Get('/drafts')
  async getDrafts(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string
  ) {
    return this.factory.getDrafts(org.id, Number(limit || 20));
  }

  @Get('/drafts/paged')
  async getDraftsPaged(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: 'createdAt' | 'updatedAt' | 'reviewStatus' | 'score',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    return this.factory.getDraftsPaged(org.id, {
      page: Number(page || 1),
      pageSize: Number(pageSize || 20),
      sortBy,
      sortOrder,
    });
  }

  @Get('/content')
  async getSourceContents(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string
  ) {
    return this.factory.getSourceContents(org.id, Number(limit || 20));
  }

  @Get('/content/paged')
  async getSourceContentsPaged(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: 'createdAt' | 'platform' | 'authorName',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    return this.factory.getSourceContentsPaged(org.id, {
      page: Number(page || 1),
      pageSize: Number(pageSize || 20),
      sortBy,
      sortOrder,
    });
  }

  @Get('/publish-jobs')
  async getPublishJobs(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string
  ) {
    return this.factory.getPublishJobs(org.id, Number(limit || 20));
  }

  @Get('/drafts/:draftId/publish-job')
  async getPublishJobByDraftId(
    @GetOrgFromRequest() org: Organization,
    @Param('draftId') draftId: string
  ) {
    return this.factory.getPublishJobByDraftId(org.id, draftId);
  }

  @Get('/publish-jobs/paged')
  async getPublishJobsPaged(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy')
    sortBy?: 'createdAt' | 'updatedAt' | 'status' | 'publishedAt' | 'retryCount',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    return this.factory.getPublishJobsPaged(org.id, {
      page: Number(page || 1),
      pageSize: Number(pageSize || 20),
      sortBy,
      sortOrder,
    });
  }

  @Get('/metrics')
  async getMetrics(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string
  ) {
    return this.factory.getMetrics(org.id, {
      days: Number(days || 7),
    });
  }

  @Get('/metrics/stages')
  async getStageDistribution(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string
  ) {
    return this.factory.getStageDistribution(org.id, {
      days: Number(days || 7),
    });
  }

  @Get('/metrics/trend')
  async getMetricsTrend(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string
  ) {
    return this.factory.getMetricsTrend(org.id, {
      days: Number(days || 7),
    });
  }

  @Get('/publish-jobs/retry-insights')
  async getPublishRetryInsights(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string,
    @Query('maxRetryCount') maxRetryCount?: string
  ) {
    return this.factory.getPublishRetryInsights(org.id, {
      days: Number(days || 7),
      maxRetryCount: Number(maxRetryCount || 3),
    });
  }

  @Get('/publish-jobs/retry-history')
  async getPublishRetryHistory(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('operator') operator?: string,
    @Query('skipped') skipped?: 'true' | 'false',
    @Query('errorCode') errorCode?: string
  ) {
    return this.factory.getPublishRetryHistory(org.id, {
      days: Number(days || 7),
      limit: Number(limit || 20),
      operator,
      skipped,
      errorCode,
    });
  }

  @Get('/publish-jobs/retry-history/summary')
  async getPublishRetryHistorySummary(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string,
    @Query('operator') operator?: string,
    @Query('skipped') skipped?: 'true' | 'false',
    @Query('errorCode') errorCode?: string
  ) {
    return this.factory.getPublishRetryHistorySummary(org.id, {
      days: Number(days || 7),
      operator,
      skipped,
      errorCode,
    });
  }

  @Get('/publish-jobs/retry-history/export.csv')
  async exportPublishRetryHistoryCsv(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('operator') operator?: string,
    @Query('skipped') skipped?: 'true' | 'false',
    @Query('errorCode') errorCode?: string,
    @Res() res?: Response
  ) {
    const csv = await this.factory.exportPublishRetryHistoryCsv(org.id, {
      days: Number(days || 7),
      limit: Number(limit || 1000),
      operator,
      skipped,
      errorCode,
    });
    const filename = `factory_retry_history_${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, '-')}.csv`;
    res?.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res?.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res?.send(csv);
  }

  @Get('/publish-jobs/retry-preview')
  async previewRetryFailedPublishJobs(
    @GetOrgFromRequest() org: Organization,
    @Query('errorCode') errorCode?: string,
    @Query('maxRetryCount') maxRetryCount?: string,
    @Query('batchSize') batchSize?: string,
    @Query('cooldownMinutes') cooldownMinutes?: string,
    @Query('concurrency') concurrency?: string,
    @Query('force') force?: string
  ) {
    return this.factory.previewRetryFailedPublishJobs(org.id, {
      errorCode: errorCode || undefined,
      maxRetryCount: Number(maxRetryCount || 3),
      batchSize: Number(batchSize || 50),
      cooldownMinutes: Number(cooldownMinutes || 0),
      concurrency: Number(concurrency || 5),
      force: force === '1' || force === 'true',
    });
  }

  @Post('/publish-jobs/retry-history/:logId/replay')
  async replayPublishRetryHistory(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('logId') logId: string,
    @Body()
    body?: {
      force?: boolean;
      cooldownMinutes?: number;
      concurrency?: number;
      batchSize?: number;
      maxRetryCount?: number;
    }
  ) {
    return this.factory.replayPublishRetryHistory(org.id, user.id, logId, body || {});
  }

  @Get('/publish-jobs/retry-history/:logId')
  async getPublishRetryHistoryDetail(
    @GetOrgFromRequest() org: Organization,
    @Param('logId') logId: string
  ) {
    return this.factory.getPublishRetryHistoryDetail(org.id, logId);
  }

  @Get('/logs')
  async getLogs(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string,
    @Query('trace_id') traceId?: string,
    @Query('operator') operator?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    return this.factory.getAuditLogs(org.id, {
      limit: Number(limit || 50),
      traceId,
      operator,
      action,
      from,
      to,
    });
  }

  @Get('/logs/paged')
  async getLogsPaged(
    @GetOrgFromRequest() org: Organization,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: 'createdAt' | 'action' | 'operator' | 'resourceType',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('trace_id') traceId?: string,
    @Query('operator') operator?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    return this.factory.getAuditLogsPaged(org.id, {
      page: Number(page || 1),
      pageSize: Number(pageSize || 50),
      sortBy,
      sortOrder,
      traceId,
      operator,
      action,
      from,
      to,
    });
  }

  @Get('/logs/export.csv')
  async exportLogsCsv(
    @GetOrgFromRequest() org: Organization,
    @Query('limit') limit?: string,
    @Query('trace_id') traceId?: string,
    @Query('operator') operator?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Res() res?: Response
  ) {
    const csv = await this.factory.exportAuditLogsCsv(org.id, {
      limit: Number(limit || 1000),
      traceId,
      operator,
      action,
      from,
      to,
    });
    const filename = `factory_audit_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    res?.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res?.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res?.send(csv);
  }
}
