import { MaterialsController } from '@gitroom/backend/api/routes/materials.controller';

describe('MaterialsController search history behavior', () => {
  const buildController = () => {
    const queue = {
      enqueueJob: jest.fn(),
    } as any;
    const events = {} as any;
    const crawler = {
      readFile: jest.fn(),
      listFiles: jest.fn().mockResolvedValue([]),
    } as any;
    const materials = {
      buildQueryHash: jest.fn().mockReturnValue('query-hash'),
      resolveKeywordResults: jest.fn(),
      getCachedResult: jest.fn(),
      isPreferredResultPath: jest.fn().mockReturnValue(true),
      clearCachedResult: jest.fn(),
      getResultsLimit: jest.fn().mockReturnValue(200),
    } as any;
    const materialsAnalysis = {} as any;
    const materialsAnalysisQueue = {} as any;

    const controller = new MaterialsController(
      queue,
      events,
      crawler,
      materials,
      materialsAnalysis,
      materialsAnalysisQueue
    );

    return { controller, queue, crawler, materials };
  };

  it('returns history cache immediately for non-incremental search', async () => {
    const { controller, materials, queue } = buildController();
    materials.resolveKeywordResults.mockResolvedValue({
      resultPath: '/tmp/history.json',
      count: 2,
      preview: [{ id: 'a' }],
      data: {
        data: [{ id: 'a' }, { id: 'b' }],
        total: 2,
      },
      sourcePaths: ['/tmp/history.json'],
    });

    const result = await controller.search(
      { id: 'org-1' } as any,
      {
        platform: 'xhs',
        keywords: '口红测评',
      } as any
    );

    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect(result.incremental).toBe(false);
    expect(result.count).toBe(2);
  });

  it('returns cached history first and enqueues job for incremental search', async () => {
    const { controller, materials, crawler, queue } = buildController();
    materials.resolveKeywordResults.mockResolvedValue(null);
    materials.getCachedResult.mockResolvedValue({
      queryHash: 'query-hash',
      resultPath: '/tmp/cached.json',
      cachedAt: '2026-02-21T00:00:00.000Z',
    });
    crawler.listFiles.mockResolvedValue([{ path: '/tmp/cached.json' }]);
    crawler.readFile.mockResolvedValue({
      data: [{ id: 'x' }, { id: 'y' }],
      total: 2,
    });

    const result = await controller.search(
      { id: 'org-1' } as any,
      {
        platform: 'xhs',
        keywords: '口红测评',
        incremental: true,
      } as any
    );

    expect(queue.enqueueJob).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('queued');
    expect(result.incremental).toBe(true);
    expect(result.historyCount).toBe(2);
    expect(result.historyResults).toEqual({
      data: [{ id: 'x' }, { id: 'y' }],
      total: 2,
    });
  });

  it('falls back to cached preview when cached result path is stale', async () => {
    const { controller, materials, crawler, queue } = buildController();
    materials.resolveKeywordResults.mockResolvedValue(null);
    materials.getCachedResult.mockResolvedValue({
      queryHash: 'query-hash',
      resultPath: '/tmp/missing.json',
      count: 1,
      preview: [{ id: 'cached-preview' }],
      cachedAt: '2026-02-21T00:00:00.000Z',
    });
    crawler.listFiles.mockResolvedValue([{ path: '/tmp/other.json' }]);

    const result = await controller.search(
      { id: 'org-1' } as any,
      {
        platform: 'xhs',
        keywords: '鍖荤編',
        incremental: true,
      } as any
    );

    expect(queue.enqueueJob).toHaveBeenCalledTimes(1);
    expect(crawler.readFile).not.toHaveBeenCalled();
    expect(materials.clearCachedResult).not.toHaveBeenCalled();
    expect(result.historyCount).toBe(1);
    expect(result.historyResults).toEqual({
      data: [{ id: 'cached-preview' }],
      total: 1,
    });
  });

  it('enqueues crawler when no history exists', async () => {
    const { controller, materials, queue } = buildController();
    materials.resolveKeywordResults.mockResolvedValue(null);
    materials.getCachedResult.mockResolvedValue(null);

    const result = await controller.search(
      { id: 'org-1' } as any,
      {
        platform: 'xhs',
        keywords: '全新关键词',
      } as any
    );

    expect(queue.enqueueJob).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
    expect(result.historyResults).toBeNull();
  });
});
