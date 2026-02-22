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
    expect(result).toEqual({ found: false, data: null });
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
        },
        force: false,
      } as any
    );

    expect(result).toEqual({
      found: true,
      source: 'cache',
      data: expect.any(Object),
    });
  });

  it('enqueues analysis job when no cache', async () => {
    const { controller, materialsAnalysis, materialsAnalysisQueue } = buildController();
    materialsAnalysis.getLatestAnalysis.mockResolvedValue(null);
    materialsAnalysisQueue.enqueueJob.mockResolvedValue({
      jobId: 'materials-analysis:test',
      reused: false,
    });

    const result = await controller.triggerAnalysis(
      { id: 'org-1' } as any,
      {
        item: {
          platform: 'xhs',
          externalId: 'abc',
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
    expect(result).toEqual({
      accepted: true,
      jobId: 'materials-analysis:test',
      reused: false,
      state: 'queued',
    });
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
});

