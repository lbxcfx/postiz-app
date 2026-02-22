import { MaterialsAnalysisService } from '@gitroom/nestjs-libraries/materials/materials.analysis.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

describe('MaterialsAnalysisService', () => {
  const createService = () => {
    const prisma = {
      sourceContent: {
        findFirst: jest.fn(),
        upsert: jest.fn(),
      },
      analysisResult: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    return {
      service: new MaterialsAnalysisService(prisma as any),
      prisma,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses image_url payload for image source in vision analysis', async () => {
    const { service } = createService();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"summary":"ok","keywords":["a"],"scenes":["b"]}',
            },
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    await (service as any).runVisionAnalysis(
      {
        platform: 'xhs',
        externalId: '1',
        coverUrl: 'https://example.com/cover.jpg',
      },
      'test-key'
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const mediaNode = payload.messages[1].content[1];
    expect(mediaNode.type).toBe('image_url');
    expect(mediaNode.image_url.url).toContain('cover.jpg');
  });

  it('uses video_url payload for video source in vision analysis', async () => {
    const { service } = createService();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"summary":"ok","keywords":["a"],"scenes":["b"]}',
            },
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    await (service as any).runVisionAnalysis(
      {
        platform: 'xhs',
        externalId: '1',
        contentUrl: 'https://example.com/video.mp4',
      },
      'test-key'
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const mediaNode = payload.messages[1].content[1];
    expect(mediaNode.type).toBe('video_url');
    expect(mediaNode.video_url.url).toContain('video.mp4');
  });

  it('returns existing result when analysis lock is occupied', async () => {
    const { service, prisma } = createService();
    const existing = {
      source: 'qwen',
      analysis: {
        scoreLayer: { overallScore: 80 },
      },
    };

    jest.spyOn(ioRedis as any, 'set').mockResolvedValueOnce(null);
    jest
      .spyOn(service as any, 'waitForLatestAnalysis')
      .mockResolvedValueOnce(existing);

    const result = await service.analyzeAndStore('org-1', {
      platform: 'xhs',
      externalId: 'a1',
    } as any);

    expect(result).toBe(existing);
    expect(prisma.sourceContent.upsert).not.toHaveBeenCalled();
    expect(prisma.analysisResult.create).not.toHaveBeenCalled();
  });
});

