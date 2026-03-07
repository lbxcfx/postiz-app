import { ContentFactoryActivity } from '@gitroom/orchestrator/activities/content-factory.activity';

describe('ContentFactoryActivity analyzeContent', () => {
  it('stores analysis results and writes analyze audit log', async () => {
    const materialsQueue = {} as any;
    const crawler = {} as any;
    const postActivity = {} as any;
    const integrationService = {} as any;
    const mediaService = {} as any;

    const prisma = {
      sourceContent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sc-1',
            title: '视频内容',
            content: '正文',
            mediaAssets: [{ type: 'video', url: 'local:demo.mp4', localPath: null }],
          },
        ]),
      },
      analysisResult: {
        create: jest.fn().mockResolvedValue({ id: 'ar-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      },
    } as any;

    const analysisService = {
      analyzeContents: jest.fn().mockResolvedValue([
        {
          sourceContentId: 'sc-1',
          type: 'video_analysis',
          modelUsed: 'local-heuristic',
          confidence: 0.6,
          result: {
            shortSummary: 'summary',
            visualSummary: 'visual',
          },
        },
      ]),
    } as any;

    const activity = new ContentFactoryActivity(
      materialsQueue,
      crawler,
      prisma,
      postActivity,
      integrationService,
      analysisService,
      mediaService
    );

    const output = await activity.analyzeContent({
      organizationId: 'org-1',
      sourceContentIds: ['sc-1'],
    });

    expect(prisma.sourceContent.findMany).toHaveBeenCalled();
    expect(analysisService.analyzeContents).toHaveBeenCalled();
    expect(prisma.analysisResult.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceContentId: 'sc-1',
          type: 'video_analysis',
        }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'analyze',
          resourceType: 'source_content',
        }),
      })
    );
    expect(output).toEqual([
      expect.objectContaining({
        sourceContentId: 'sc-1',
        shortSummary: 'summary',
        visualSummary: 'visual',
      }),
    ]);
  });
});

describe('ContentFactoryActivity publishContent', () => {
  it('fails fast for immediate publish when no media is available', async () => {
    const materialsQueue = {} as any;
    const crawler = {} as any;
    const analysisService = {} as any;
    const postActivity = {
      postSocial: jest.fn(),
    } as any;
    const integrationService = {
      getIntegrationById: jest.fn().mockResolvedValue({ id: 'int-1' }),
    } as any;
    const mediaService = {} as any;

    const prisma = {
      contentDraft: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'draft-1',
          organizationId: 'org-1',
          content: 'draft content',
          sourceContentIds: JSON.stringify(['sc-1']),
        }),
      },
      mediaAsset: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      publishJob: {
        upsert: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({ id: 'job-1' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      },
    } as any;

    const activity = new ContentFactoryActivity(
      materialsQueue,
      crawler,
      prisma,
      postActivity,
      integrationService,
      analysisService,
      mediaService
    );

    await expect(
      activity.publishContent({
        organizationId: 'org-1',
        draftId: 'draft-1',
        integrationId: 'int-1',
      })
    ).rejects.toThrow('FACTORY_MEDIA_REQUIRED');

    expect(prisma.publishJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'FACTORY_MEDIA_REQUIRED',
        }),
      })
    );
    expect(postActivity.postSocial).not.toHaveBeenCalled();
  });
});
