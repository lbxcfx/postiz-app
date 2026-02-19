import { AnalysisService } from '@gitroom/orchestrator/activities/analysis.service';

describe('AnalysisService', () => {
  it('returns text fallback when no video asset', async () => {
    const service = new AnalysisService();

    const results = await service.analyzeContents([
      {
        sourceContentId: 'sc-1',
        title: '测试标题',
        content: '测试正文',
        mediaAssets: [{ type: 'image', url: 'https://example.com/a.jpg' }],
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('text_fallback');
    expect(results[0].modelUsed).toBe('local-heuristic');
    expect(results[0].result.fallbackReason).toBe('NO_VIDEO_ASSET');
  });

  it('uses local heuristic when video exists but AI context missing', async () => {
    const service = new AnalysisService();
    delete process.env.QWEN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;

    const results = await service.analyzeContents([
      {
        sourceContentId: 'sc-2',
        title: '视频标题',
        content: '这是一个关于开箱体验与使用细节的描述',
        mediaAssets: [{ type: 'video', url: 'local:demo.mp4' }],
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('video_analysis');
    expect(results[0].modelUsed).toBe('local-heuristic');
    expect(typeof results[0].result.visualSummary).toBe('string');
  });
});
