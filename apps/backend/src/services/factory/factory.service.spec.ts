import { FactoryService } from './factory.service';

describe('FactoryService retry history', () => {
  const buildService = () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      publishJob: {
        findMany: jest.fn(),
      },
    };

    const temporal = {
      client: {
        getWorkflowHandle: jest.fn(),
        getRawClient: jest.fn(),
      },
    };

    const integrationService = {
      getIntegrationById: jest.fn(),
    };

    const integrationManager = {
      getSocialIntegration: jest.fn(),
    };
    const postsService = {
      mapTypeToPost: jest.fn(),
      createPost: jest.fn(),
    };

    const service = new FactoryService(
      prisma as any,
      temporal as any,
      integrationService as any,
      integrationManager as any,
      postsService as any
    );

    return { service, prisma };
  };

  it('filters retry history by skipped and errorCode', async () => {
    const { service, prisma } = buildService();
    const now = new Date('2026-02-11T10:00:00.000Z');

    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'l1',
        operator: 'u1',
        createdAt: now,
        detail: {
          mode: 'failed_auto_retry',
          skippedByCooldown: false,
          criteria: { errorCode: 'E1', maxRetryCount: 3, batchSize: 20 },
          result: { total: 2, succeeded: 1, failed: 1 },
        },
      },
      {
        id: 'l2',
        operator: 'u1',
        createdAt: now,
        detail: {
          mode: 'failed_auto_retry',
          skippedByCooldown: true,
          criteria: { errorCode: 'E1', maxRetryCount: 3, batchSize: 20 },
          result: { total: 0, succeeded: 0, failed: 0 },
        },
      },
      {
        id: 'l3',
        operator: 'u1',
        createdAt: now,
        detail: {
          mode: 'failed_auto_retry',
          skippedByCooldown: false,
          criteria: { errorCode: 'E2', maxRetryCount: 3, batchSize: 20 },
          result: { total: 1, succeeded: 1, failed: 0 },
        },
      },
    ]);

    const result = await service.getPublishRetryHistory('org-1', {
      days: 7,
      limit: 20,
      operator: 'u1',
      skipped: 'false',
      errorCode: 'E1',
    });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operator: 'u1',
        }),
      })
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('l1');
    expect(result.items[0].skippedByCooldown).toBe(false);
    expect(result.items[0].criteria.errorCode).toBe('E1');
  });

  it('aggregates summary from filtered retry history', async () => {
    const { service, prisma } = buildService();
    const now = new Date('2026-02-11T10:00:00.000Z');

    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'l1',
        operator: 'u1',
        createdAt: now,
        detail: {
          skippedByCooldown: false,
          criteria: { errorCode: 'E1' },
          result: { total: 3, succeeded: 2, failed: 1 },
        },
      },
      {
        id: 'l2',
        operator: 'u1',
        createdAt: now,
        detail: {
          skippedByCooldown: false,
          criteria: { errorCode: 'E1' },
          result: { total: 2, succeeded: 2, failed: 0 },
        },
      },
      {
        id: 'l3',
        operator: 'u2',
        createdAt: now,
        detail: {
          skippedByCooldown: true,
          criteria: { errorCode: 'E1' },
          result: { total: 0, succeeded: 0, failed: 0 },
        },
      },
    ]);

    const summary = await service.getPublishRetryHistorySummary('org-1', {
      days: 7,
      errorCode: 'E1',
    });

    expect(summary.totalBatches).toBe(3);
    expect(summary.executedBatches).toBe(2);
    expect(summary.skippedBatches).toBe(1);
    expect(summary.succeededJobs).toBe(4);
    expect(summary.failedJobs).toBe(1);
  });

  it('skips preview under cooldown when force=false', async () => {
    const { service, prisma } = buildService();
    const now = new Date('2026-02-11T10:00:00.000Z');

    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'recent',
      createdAt: now,
      detail: {
        mode: 'failed_auto_retry',
        criteria: { errorCode: 'E-COOL' },
      },
    });

    const preview = await service.previewRetryFailedPublishJobs('org-1', {
      errorCode: 'E-COOL',
      cooldownMinutes: 10,
      force: false,
      batchSize: 20,
      maxRetryCount: 3,
    });

    expect(preview.skipped).toBe(true);
    expect(preview.reason).toBe('COOLDOWN_ACTIVE');
    expect(prisma.publishJob.findMany).not.toHaveBeenCalled();
  });

  it('replays history with override params', async () => {
    const { service, prisma } = buildService();
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'log-1',
      detail: {
        criteria: {
          errorCode: 'E-HISTORY',
          maxRetryCount: 3,
          batchSize: 20,
          cooldownMinutes: 10,
          concurrency: 5,
          force: false,
        },
      },
    });

    const spy = jest
      .spyOn(service, 'bulkRetryFailedPublishJobs')
      .mockResolvedValue({ total: 0, succeeded: 0, failed: 0, failures: [] } as any);

    await service.replayPublishRetryHistory('org-1', 'operator-1', 'log-1', {
      maxRetryCount: 9,
      concurrency: 8,
      force: true,
    });

    expect(spy).toHaveBeenCalledWith(
      'org-1',
      'operator-1',
      expect.objectContaining({
        errorCode: 'E-HISTORY',
        maxRetryCount: 9,
        concurrency: 8,
        force: true,
      })
    );
  });

  it('fails fast for xiaohongshu retry when no media is available', async () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      },
      publishJob: {
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          organizationId: 'org-1',
          integrationId: 'int-1',
          contentDraft: {
            id: 'draft-1',
            content: 'retry content',
            sourceContentIds: JSON.stringify(['sc-1']),
          },
        }),
        update: jest.fn().mockResolvedValue({ id: 'job-1' }),
      },
      mediaAsset: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const temporal = {
      client: {
        getWorkflowHandle: jest.fn(),
        getRawClient: jest.fn(),
      },
    };

    const integrationService = {
      getIntegrationById: jest.fn().mockResolvedValue({
        id: 'int-1',
        internalId: 'internal-1',
        token: '{}',
        providerIdentifier: 'xiaohongshu',
      }),
    };

    const provider = {
      post: jest.fn(),
    };
    const integrationManager = {
      getSocialIntegration: jest.fn().mockReturnValue(provider),
    };
    const postsService = {
      mapTypeToPost: jest.fn(),
      createPost: jest.fn(),
    };

    const service = new FactoryService(
      prisma as any,
      temporal as any,
      integrationService as any,
      integrationManager as any,
      postsService as any
    );

    await expect(service.retryPublishJob('org-1', 'job-1', 'operator-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'FACTORY_MEDIA_REQUIRED',
      }),
    });

    expect(prisma.publishJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'FACTORY_MEDIA_REQUIRED',
        }),
      })
    );
    expect(provider.post).not.toHaveBeenCalled();
  });
});
