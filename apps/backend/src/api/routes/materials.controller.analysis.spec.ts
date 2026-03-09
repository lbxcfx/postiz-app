import { MaterialsController } from '@gitroom/backend/api/routes/materials.controller';

describe('MaterialsController analysis endpoints', () => {
  const buildController = () => {
    const queue = {} as any;
    const events = {} as any;
    const crawler = {} as any;
    const materials = {} as any;
    const materialsAnalysis = {
      getLatestAnalysis: jest.fn(),
    };
    const materialsAnalysisQueue = {
      enqueueJob: jest.fn(),
      getJobStatus: jest.fn(),
      cancelJob: jest.fn(),
      incrementMetric: jest.fn(),
      getMetrics: jest.fn(),
      appendMetricsHistory: jest.fn(),
      getMetricsHistory: jest.fn(),
    };

    const controller = new MaterialsController(
      queue,
      events,
      crawler,
      materials,
      materialsAnalysis as any,
      materialsAnalysisQueue as any
    );

    return { controller, materialsAnalysis, materialsAnalysisQueue };
  };

  it('returns found=false when analysis not exists', async () => {
    const { controller, materialsAnalysis } = buildController();
    materialsAnalysis.getLatestAnalysis.mockResolvedValue(null);

    const result = await controller.getAnalysis(
      { id: 'org-1' } as any,
      'xhs',
      'abc'
    );

    expect(materialsAnalysis.getLatestAnalysis).toHaveBeenCalledWith(
      'org-1',
      'xhs',
      'abc'
    );
    expect(result).toEqual(
      expect.objectContaining({
        found: false,
        data: null,
        cacheHit: false,
        cacheSource: 'analysisResult',
      })
    );
  });

  it('returns cache immediately on trigger when existing and force=false', async () => {
    const { controller, materialsAnalysis } = buildController();
    materialsAnalysis.getLatestAnalysis.mockResolvedValue({
      source: 'qwen',
      analysis: { scoreLayer: { overallScore: 88 } },
    });

    const result = await controller.triggerAnalysis(
      { id: 'org-1' } as any,
      {
        item: {
          platform: 'xhs',
          externalId: 'abc',
          contentUrl: 'https://example.com/video.mp4',
        },
        force: false,
      } as any
    );

    expect(result).toEqual(
      expect.objectContaining({
        found: true,
        source: 'cache',
        data: expect.any(Object),
        cacheHit: true,
        cacheSource: 'analysisResult',
      })
    );
  });

  it('returns analysis metrics with cache hit rate', async () => {
    const { controller, materialsAnalysisQueue } = buildController();
    materialsAnalysisQueue.getMetrics.mockResolvedValue({
      enqueuedNew: 3,
      reusedInflight: 1,
      reusedExisting: 1,
      workerCacheHit: 4,
      workerFreshRun: 6,
      cancelRequestedRunning: 1,
      cancelQueued: 1,
      cancelled: 2,
    });
    materialsAnalysisQueue.getMetricsHistory.mockResolvedValue([
      {
        generatedAt: '2026-03-08T10:00:00.000Z',
        cacheHitRate: 0.4,
      },
    ]);

    const result = await controller.getAnalysisMetrics({ id: 'org-1' } as any);

    expect(materialsAnalysisQueue.getMetrics).toHaveBeenCalledWith('org-1');
    expect(materialsAnalysisQueue.appendMetricsHistory).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        cacheHitRate: 0.4,
        workerCacheHit: 4,
        workerFreshRun: 6,
      })
    );
    expect(materialsAnalysisQueue.getMetricsHistory).toHaveBeenCalledWith('org-1', 36);
    expect(result).toEqual(
      expect.objectContaining({
        orgId: 'org-1',
        cacheHitRate: 0.4,
        history: expect.any(Array),
        metrics: expect.objectContaining({
          enqueuedNew: 3,
          workerCacheHit: 4,
          workerFreshRun: 6,
        }),
      })
    );
  });

  it('enqueues analysis job when no cache', async () => {
    const { controller, materialsAnalysis, materialsAnalysisQueue } = buildController();
    materialsAnalysis.getLatestAnalysis.mockResolvedValue(null);
    materialsAnalysisQueue.enqueueJob.mockResolvedValue({
      jobId: 'materials-analysis:test',
      reused: false,
      reason: 'new',
      dedupeKey: 'materials-analysis:dedupe',
    });
    materialsAnalysisQueue.getJobStatus.mockResolvedValue({
      jobId: 'materials-analysis:test',
      state: 'queued',
      queuePosition: 2,
      progress: 0,
      error: null,
      result: null,
    });

    const result = await controller.triggerAnalysis(
      { id: 'org-1' } as any,
      {
        item: {
          platform: 'xhs',
          externalId: 'abc',
          contentUrl: 'https://example.com/video.mp4',
          title: 'title',
          desc: 'desc',
        },
      } as any
    );

    expect(materialsAnalysisQueue.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        force: false,
        item: expect.objectContaining({
          platform: 'xhs',
          externalId: 'abc',
          title: 'title',
          desc: 'desc',
        }),
      })
    );
    expect(materialsAnalysisQueue.getJobStatus).toHaveBeenCalledWith(
      'materials-analysis:test',
      'org-1'
    );
    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        jobId: 'materials-analysis:test',
        reused: false,
        state: 'queued',
        queueReason: 'new',
        dedupeKey: 'materials-analysis:dedupe',
        queuePosition: 2,
        cacheHit: false,
      })
    );
  });

  it('reuses inflight job and returns queued state with queue position', async () => {
    const { controller, materialsAnalysis, materialsAnalysisQueue } = buildController();
    materialsAnalysis.getLatestAnalysis.mockResolvedValue(null);
    materialsAnalysisQueue.enqueueJob.mockResolvedValue({
      jobId: 'materials-analysis:shared',
      reused: true,
      reason: 'inflight',
      dedupeKey: 'materials-analysis:dedupe',
    });
    materialsAnalysisQueue.getJobStatus.mockResolvedValue({
      jobId: 'materials-analysis:shared',
      state: 'queued',
      queuePosition: 3,
      progress: 0.1,
      error: null,
      result: null,
    });

    const result = await controller.triggerAnalysis(
      { id: 'org-1' } as any,
      {
        item: {
          platform: 'xhs',
          externalId: 'shared',
          contentUrl: 'https://example.com/shared.mp4',
        },
      } as any
    );

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        jobId: 'materials-analysis:shared',
        reused: true,
        state: 'queued',
        queueReason: 'inflight',
        queuePosition: 3,
        cacheReason: 'inflight-reused',
      })
    );
  });

  it('queries job status with org scope', async () => {
    const { controller, materialsAnalysisQueue } = buildController();
    materialsAnalysisQueue.getJobStatus.mockResolvedValue({
      jobId: 'j1',
      state: 'running',
      progress: 0.5,
      error: null,
      result: null,
    });

    const result = await controller.getAnalysisJobStatus(
      { id: 'org-1' } as any,
      'j1'
    );

    expect(materialsAnalysisQueue.getJobStatus).toHaveBeenCalledWith('j1', 'org-1');
    expect(result.state).toBe('running');
  });

  it('cancels analysis job with org scope', async () => {
    const { controller, materialsAnalysisQueue } = buildController();
    materialsAnalysisQueue.cancelJob.mockResolvedValue({
      cancelled: true,
      state: 'running',
      message: 'Cancel requested. Running task will stop on next checkpoint.',
    });

    const result = await controller.cancelAnalysis(
      { id: 'org-1' } as any,
      { jobId: 'j1' } as any
    );

    expect(materialsAnalysisQueue.cancelJob).toHaveBeenCalledWith('j1', 'org-1');
    expect(result).toEqual(
      expect.objectContaining({
        jobId: 'j1',
        cancelled: true,
        state: 'running',
      })
    );
  });
});
