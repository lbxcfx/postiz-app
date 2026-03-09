import { MaterialsAnalysisService } from '@gitroom/nestjs-libraries/materials/materials.analysis.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MaterialsAnalysisService', () => {
  const restoreEnv = (key: string, value: string | undefined) => {
    if (typeof value === 'undefined') {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

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
    const previousProvider = process.env.MATERIALS_VL_PROVIDER;
    process.env.MATERIALS_VL_PROVIDER = 'aliyun';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"summary":"ok","keywords":["a"],"scenes":["b"],"frameAnalyses":[{"timestampSec":1,"summary":"frame-1","keywords":["k1"]}]}',
            },
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    const result = await (service as any).runVisionAnalysis(
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
    expect(result.frameAnalyses).toHaveLength(1);
    expect(result.frameAnalyses[0].summary).toBe('frame-1');
    restoreEnv('MATERIALS_VL_PROVIDER', previousProvider);
  });

  it('uses video_url payload for video source in vision analysis', async () => {
    const { service } = createService();
    const previousProvider = process.env.MATERIALS_VL_PROVIDER;
    process.env.MATERIALS_VL_PROVIDER = 'aliyun';
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
    restoreEnv('MATERIALS_VL_PROVIDER', previousProvider);
  });

  it('returns thumbnailUrl for extracted keyframes', async () => {
    const { service } = createService();
    jest
      .spyOn(service as any, 'extractFramesAsDataUrls')
      .mockResolvedValueOnce([
        {
          index: 1,
          timestampSec: 3,
          timestampLabel: '00:03',
          imageDataUrl: 'data:image/jpeg;base64,abc123',
        },
      ]);

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"summary":"frame summary","keywords":["hook"],"scene":"clinic desk"}',
            },
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    const result = await (service as any).runFrameLevelVisionAnalysis(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'test-key',
      'qwen-vl-max-latest',
      {
        platform: 'xhs',
        externalId: '1',
        title: 'demo',
        desc: 'demo desc',
      },
      'https://example.com/video.mp4'
    );

    expect(result).toBeTruthy();
    expect(result.frameAnalyses[0].thumbnailUrl).toBe('data:image/jpeg;base64,abc123');
    expect(result.frameAnalyses[0].timestampLabel).toBe('00:03');
  });

  it('switches to doubao vision provider when configured', async () => {
    const { service } = createService();
    const previousEnv = {
      MATERIALS_VL_PROVIDER: process.env.MATERIALS_VL_PROVIDER,
      DOUBAO_ARK_API_KEY: process.env.DOUBAO_ARK_API_KEY,
      DOUBAO_ARK_ENDPOINT_ID: process.env.DOUBAO_ARK_ENDPOINT_ID,
      DOUBAO_ARK_BASE_URL: process.env.DOUBAO_ARK_BASE_URL,
      DOUBAO_VL_API_MODE: process.env.DOUBAO_VL_API_MODE,
      DOUBAO_VL_MODEL: process.env.DOUBAO_VL_MODEL,
    };
    process.env.MATERIALS_VL_PROVIDER = 'doubao';
    process.env.DOUBAO_ARK_API_KEY = 'ark-test-key';
    process.env.DOUBAO_ARK_ENDPOINT_ID = 'ep-test-vl';
    process.env.DOUBAO_VL_MODEL = '';
    process.env.DOUBAO_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
    process.env.DOUBAO_VL_API_MODE = 'responses';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text:
          '{"summary":"ok","keywords":["a"],"scenes":["b"],"keyframes":["00:01 hook"]}',
      }),
    });
    (global as any).fetch = fetchMock;

    const result = await (service as any).runVisionAnalysis({
      platform: 'xhs',
      externalId: '1',
      coverUrl: 'https://example.com/cover.jpg',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/responses'
    );
    const requestInit = fetchMock.mock.calls[0][1];
    expect(requestInit.headers.authorization).toBe('Bearer ark-test-key');
    const payload = JSON.parse(requestInit.body);
    expect(payload.model).toBe('ep-test-vl');
    expect(payload.input[0].content[0].type).toBe('input_image');
    expect(payload.input[0].content[1].type).toBe('input_text');
    expect(result.modelUsed).toContain('(doubao-responses)');

    restoreEnv('MATERIALS_VL_PROVIDER', previousEnv.MATERIALS_VL_PROVIDER);
    restoreEnv('DOUBAO_ARK_API_KEY', previousEnv.DOUBAO_ARK_API_KEY);
    restoreEnv('DOUBAO_ARK_ENDPOINT_ID', previousEnv.DOUBAO_ARK_ENDPOINT_ID);
    restoreEnv('DOUBAO_ARK_BASE_URL', previousEnv.DOUBAO_ARK_BASE_URL);
    restoreEnv('DOUBAO_VL_API_MODE', previousEnv.DOUBAO_VL_API_MODE);
    restoreEnv('DOUBAO_VL_MODEL', previousEnv.DOUBAO_VL_MODEL);
  });

  it('parses doubao responses output message content', async () => {
    const { service } = createService();
    const previousEnv = {
      MATERIALS_VL_PROVIDER: process.env.MATERIALS_VL_PROVIDER,
      DOUBAO_ARK_API_KEY: process.env.DOUBAO_ARK_API_KEY,
      DOUBAO_VL_MODEL: process.env.DOUBAO_VL_MODEL,
      DOUBAO_ARK_BASE_URL: process.env.DOUBAO_ARK_BASE_URL,
      DOUBAO_VL_API_MODE: process.env.DOUBAO_VL_API_MODE,
    };
    process.env.MATERIALS_VL_PROVIDER = 'doubao';
    process.env.DOUBAO_ARK_API_KEY = 'ark-test-key';
    process.env.DOUBAO_VL_MODEL = 'doubao-seed-2-0-mini-260215';
    process.env.DOUBAO_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
    process.env.DOUBAO_VL_API_MODE = 'responses';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '{"summary":"resp-ok","keywords":["k1"],"scenes":["s1"]}',
              },
            ],
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    const result = await (service as any).runVisionAnalysis({
      platform: 'xhs',
      externalId: '2',
      coverUrl: 'https://example.com/cover.jpg',
    });

    expect(result.modelUsed).toContain('(doubao-responses)');
    expect(result.summary).toBe('resp-ok');
    expect(result.keywords).toContain('k1');

    restoreEnv('MATERIALS_VL_PROVIDER', previousEnv.MATERIALS_VL_PROVIDER);
    restoreEnv('DOUBAO_ARK_API_KEY', previousEnv.DOUBAO_ARK_API_KEY);
    restoreEnv('DOUBAO_VL_MODEL', previousEnv.DOUBAO_VL_MODEL);
    restoreEnv('DOUBAO_ARK_BASE_URL', previousEnv.DOUBAO_ARK_BASE_URL);
    restoreEnv('DOUBAO_VL_API_MODE', previousEnv.DOUBAO_VL_API_MODE);
  });

  it('uses doubao llm chat completions for semantic analysis', async () => {
    const { service } = createService();
    const previousEnv = {
      MATERIALS_LLM_PROVIDER: process.env.MATERIALS_LLM_PROVIDER,
      DOUBAO_LLM_API_KEY: process.env.DOUBAO_LLM_API_KEY,
      DOUBAO_LLM_BASE_URL: process.env.DOUBAO_LLM_BASE_URL,
      DOUBAO_LLM_MODEL: process.env.DOUBAO_LLM_MODEL,
    };
    process.env.MATERIALS_LLM_PROVIDER = 'doubao';
    process.env.DOUBAO_LLM_API_KEY = 'doubao-llm-key';
    process.env.DOUBAO_LLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
    process.env.DOUBAO_LLM_MODEL = 'doubao-1-5-pro-32k-250115';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"summary":"semantic-ok","highlights":["h1"],"keywords":["k1"],"insights":["i1"],"tone":"neutral","fullSummary360":"f360"}',
            },
          },
        ],
      }),
    });
    (global as any).fetch = fetchMock;

    const semantic = await (service as any).runSemanticAnalysis(
      { platform: 'xhs', externalId: 's1', title: 't', desc: 'd' },
      {
        frameAnalyses: [],
        modelUsed: 'vl',
        confidence: 0.8,
        mediaUrl: 'https://example.com/a.jpg',
        mediaType: 'image',
        summary: 'vision summary',
        keywords: ['vk'],
        scenes: ['scene'],
        keyframes: ['kf'],
        rawText: 'raw',
      },
      {
        modelUsed: 'asr',
        confidence: 0.8,
        audioSource: 'https://example.com/a.mp3',
        transcript: 'hello',
        language: 'zh',
        emotion: 'stable',
        segments: [{ startSec: 0, endSec: 1, text: 'hello' }],
        rawText: 'raw',
      },
      'doubao',
      'doubao-llm-key'
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
    );
    const requestInit = fetchMock.mock.calls[0][1];
    expect(requestInit.headers.authorization).toBe('Bearer doubao-llm-key');
    const payload = JSON.parse(requestInit.body);
    expect(payload.model).toBe('doubao-1-5-pro-32k-250115');
    expect(semantic.modelUsed).toContain('(doubao-llm)');
    expect(semantic.summary).toBe('semantic-ok');

    restoreEnv('MATERIALS_LLM_PROVIDER', previousEnv.MATERIALS_LLM_PROVIDER);
    restoreEnv('DOUBAO_LLM_API_KEY', previousEnv.DOUBAO_LLM_API_KEY);
    restoreEnv('DOUBAO_LLM_BASE_URL', previousEnv.DOUBAO_LLM_BASE_URL);
    restoreEnv('DOUBAO_LLM_MODEL', previousEnv.DOUBAO_LLM_MODEL);
  });

  it('uses doubao asr submit/query flow when configured', async () => {
    const { service } = createService();
    const previousEnv = {
      MATERIALS_ASR_PROVIDER: process.env.MATERIALS_ASR_PROVIDER,
      DOUBAO_APP_ID: process.env.DOUBAO_APP_ID,
      DOUBAO_ACCESS_TOKEN: process.env.DOUBAO_ACCESS_TOKEN,
      DOUBAO_SECRET_TOKEN: process.env.DOUBAO_SECRET_TOKEN,
      DOUBAO_ASR_RESOURCE_ID: process.env.DOUBAO_ASR_RESOURCE_ID,
      DOUBAO_ASR_SUBMIT_URL: process.env.DOUBAO_ASR_SUBMIT_URL,
      DOUBAO_ASR_QUERY_URL: process.env.DOUBAO_ASR_QUERY_URL,
      DOUBAO_ASR_MAX_POLLS: process.env.DOUBAO_ASR_MAX_POLLS,
      DOUBAO_ASR_POLL_INTERVAL_MS: process.env.DOUBAO_ASR_POLL_INTERVAL_MS,
    };
    process.env.MATERIALS_ASR_PROVIDER = 'doubao';
    process.env.DOUBAO_APP_ID = 'app-test';
    process.env.DOUBAO_ACCESS_TOKEN = '';
    process.env.DOUBAO_SECRET_TOKEN = 'secret-token-test';
    process.env.DOUBAO_ASR_RESOURCE_ID = 'volc.bigasr.auc';
    process.env.DOUBAO_ASR_SUBMIT_URL =
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
    process.env.DOUBAO_ASR_QUERY_URL =
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';
    process.env.DOUBAO_ASR_MAX_POLLS = '2';
    process.env.DOUBAO_ASR_POLL_INTERVAL_MS = '1';

    const makeHeaders = (entries: Record<string, string>) => ({
      get: (key: string) => entries[key.toLowerCase()] || null,
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: makeHeaders({
          'x-api-status-code': '20000000',
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: makeHeaders({
          'x-api-status-code': '20000000',
          'x-api-message': 'Success',
        }),
        text: async () =>
          JSON.stringify({
            result: {
              text: '你好，世界',
              utterances: [
                { start_time: 0, end_time: 1200, text: '你好，世界' },
              ],
            },
          }),
      });
    (global as any).fetch = fetchMock;

    const result = await (service as any).runAsrAnalysis({
      platform: 'xhs',
      externalId: '1',
      contentUrl: 'https://example.com/video.mp4',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
    );
    const submitRequestInit = fetchMock.mock.calls[0][1];
    expect(submitRequestInit.headers['X-Api-Access-Key']).toBe('secret-token-test');
    expect(submitRequestInit.headers['X-Api-Sequence']).toBe('-1');
    expect(submitRequestInit.headers.Authorization).toBe('Bearer; secret-token-test');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'
    );
    expect(result.modelUsed).toContain('doubao-asr');
    expect(result.transcript).toContain('你好');
    expect(result.segments[0].startSec).toBe(0);
    expect(result.segments[0].endSec).toBeGreaterThan(1);

    restoreEnv('MATERIALS_ASR_PROVIDER', previousEnv.MATERIALS_ASR_PROVIDER);
    restoreEnv('DOUBAO_APP_ID', previousEnv.DOUBAO_APP_ID);
    restoreEnv('DOUBAO_ACCESS_TOKEN', previousEnv.DOUBAO_ACCESS_TOKEN);
    restoreEnv('DOUBAO_SECRET_TOKEN', previousEnv.DOUBAO_SECRET_TOKEN);
    restoreEnv('DOUBAO_ASR_RESOURCE_ID', previousEnv.DOUBAO_ASR_RESOURCE_ID);
    restoreEnv('DOUBAO_ASR_SUBMIT_URL', previousEnv.DOUBAO_ASR_SUBMIT_URL);
    restoreEnv('DOUBAO_ASR_QUERY_URL', previousEnv.DOUBAO_ASR_QUERY_URL);
    restoreEnv('DOUBAO_ASR_MAX_POLLS', previousEnv.DOUBAO_ASR_MAX_POLLS);
    restoreEnv(
      'DOUBAO_ASR_POLL_INTERVAL_MS',
      previousEnv.DOUBAO_ASR_POLL_INTERVAL_MS
    );
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

  it('loads content outline prompt from external template directory', async () => {
    const previousDir = process.env.MATERIALS_PROMPT_DIR;
    const promptDir = mkdtempSync(join(tmpdir(), 'materials-prompts-'));
    try {
      writeFileSync(
        join(promptDir, 'content-outline.prompt.txt'),
        [
          'Return JSON only.',
          'title={{title}}',
          'desc={{desc}}',
          'segments={{asr_segments}}',
        ].join('\n'),
        'utf8'
      );
      process.env.MATERIALS_PROMPT_DIR = promptDir;

      const { service } = createService();
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"items":[{"id":"o1","title":"Hook","summary":"S","keywords":["k"]}]}',
              },
            },
          ],
        }),
      });
      (global as any).fetch = fetchMock;

      const outline = await (service as any).runContentOutlineStep(
        { platform: 'xhs', externalId: 'x1', title: 'TitleA', desc: 'DescA' },
        [{ startSec: 0, endSec: 1.5, text: 'Hello world' }],
        'qwen-test',
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        'api-key'
      );

      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      const userPrompt = payload.messages[1].content as string;
      expect(userPrompt).toContain('title=TitleA');
      expect(userPrompt).toContain('desc=DescA');
      expect(userPrompt).toContain('[00:00-00:01] Hello world');
      expect(outline.source).toBe('qwen');
      expect(outline.items[0].id).toBe('o1');
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
      restoreEnv('MATERIALS_PROMPT_DIR', previousDir);
    }
  });

  it('uses env prompt version in fallback content understanding', () => {
    const previousVersion = process.env.MATERIALS_CONTENT_PROMPT_VERSION;
    try {
      process.env.MATERIALS_CONTENT_PROMPT_VERSION = 'autoclip-migrated-v2-e2e';
      const { service } = createService();

      const layer = (service as any).buildFallbackContentUnderstanding(
        { platform: 'xhs', externalId: 'x1', title: 'Demo', desc: 'Demo desc' },
        {
          modelUsed: 'local',
          confidence: 0.6,
          audioSource: '',
          transcript: 'A transcript',
          language: 'zh',
          emotion: 'stable',
          segments: [{ startSec: 0, endSec: 2, text: 'A transcript' }],
          rawText: '',
        }
      );

      expect(layer.promptVersion).toBe('autoclip-migrated-v2-e2e');
    } finally {
      restoreEnv('MATERIALS_CONTENT_PROMPT_VERSION', previousVersion);
    }
  });
});
