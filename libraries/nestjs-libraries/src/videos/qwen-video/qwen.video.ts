import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  URL,
  Video,
  VideoAbstract,
} from '@gitroom/nestjs-libraries/videos/video.interface';
import { timer } from '@gitroom/helpers/utils/timer';

class QwenVideoParams {
  @IsIn(['text-to-video', 'image-to-video', 'image-to-video-first-last'])
  mode: 'text-to-video' | 'image-to-video' | 'image-to-video-first-last';

  @IsString()
  prompt: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  firstFrameUrl?: string;

  @IsOptional()
  @IsString()
  lastFrameUrl?: string;
}

@Video({
  identifier: 'qwen-video',
  title: 'Qwen Video (DashScope)',
  description:
    'Generate videos with DashScope Wan models: text-to-video, image-to-video, and first-last frame image-to-video.',
  placement: 'text-to-image',
  dto: QwenVideoParams,
  tools: [],
  trial: false,
  available: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY),
})
export class QwenVideo extends VideoAbstract<QwenVideoParams> {
  override dto = QwenVideoParams;

  private getApiKey() {
    return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
  }

  private getTextToVideoModel() {
    return process.env.QWEN_TEXT_TO_VIDEO_MODEL || 'wanx2.1-t2v-turbo';
  }

  private getImageToVideoModel() {
    return process.env.QWEN_IMAGE_TO_VIDEO_MODEL || 'wanx2.1-i2v-turbo';
  }

  private getFirstLastModel() {
    return process.env.QWEN_IMAGE_TO_VIDEO_FIRST_LAST_MODEL || 'wanx2.1-kf2v-plus';
  }

  private getEndpoint(mode: QwenVideoParams['mode']) {
    if (mode === 'text-to-video') {
      return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
    }
    if (mode === 'image-to-video') {
      return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis';
    }
    return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis';
  }

  private buildInput(
    mode: QwenVideoParams['mode'],
    prompt: string,
    customParams: QwenVideoParams
  ) {
    if (mode === 'text-to-video') {
      return {
        prompt,
      };
    }
    if (mode === 'image-to-video') {
      if (!customParams.imageUrl) {
        throw new Error('imageUrl is required for image-to-video mode');
      }
      return {
        prompt,
        img_url: customParams.imageUrl,
      };
    }
    if (!customParams.firstFrameUrl || !customParams.lastFrameUrl) {
      throw new Error(
        'firstFrameUrl and lastFrameUrl are required for image-to-video-first-last mode'
      );
    }
    return {
      prompt,
      first_frame_url: customParams.firstFrameUrl,
      last_frame_url: customParams.lastFrameUrl,
    };
  }

  private buildPayload(
    mode: QwenVideoParams['mode'],
    output: 'vertical' | 'horizontal',
    customParams: QwenVideoParams
  ) {
    const prompt = (customParams.prompt || '').trim();
    if (!prompt) {
      throw new Error('prompt is required');
    }
    const size = output === 'horizontal' ? '1280*720' : '720*1280';
    const model =
      mode === 'text-to-video'
        ? this.getTextToVideoModel()
        : mode === 'image-to-video'
        ? this.getImageToVideoModel()
        : this.getFirstLastModel();
    return {
      model,
      input: this.buildInput(mode, prompt, customParams),
      parameters: {
        size,
      },
    };
  }

  private async createTask(
    mode: QwenVideoParams['mode'],
    output: 'vertical' | 'horizontal',
    customParams: QwenVideoParams
  ) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is required');
    }
    const endpoint = this.getEndpoint(mode);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(this.buildPayload(mode, output, customParams)),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DashScope create task failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as {
      output?: {
        task_id?: string;
      };
    };
    const taskId = data?.output?.task_id;
    if (!taskId) {
      throw new Error('DashScope task_id is empty');
    }
    return taskId;
  }

  private async pollTask(taskId: string) {
    const apiKey = this.getApiKey();
    const maxAttempts = Math.max(
      Number(process.env.QWEN_VIDEO_POLL_MAX_ATTEMPTS || 120),
      10
    );
    const intervalMs = Math.max(
      Number(process.env.QWEN_VIDEO_POLL_INTERVAL_MS || 5000),
      1000
    );

    for (let i = 0; i < maxAttempts; i += 1) {
      const response = await fetch(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
          },
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DashScope query task failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as {
        output?: {
          task_status?: string;
          video_url?: string;
          video?: {
            url?: string;
          };
          results?: Array<{ url?: string; video_url?: string }>;
        };
      };
      const status = data?.output?.task_status || '';
      if (status === 'SUCCEEDED') {
        const url =
          data?.output?.video_url ||
          data?.output?.video?.url ||
          data?.output?.results?.[0]?.video_url ||
          data?.output?.results?.[0]?.url;
        if (!url) {
          throw new Error('DashScope task succeeded but video url missing');
        }
        return url;
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        throw new Error(`DashScope task failed with status: ${status}`);
      }
      await timer(intervalMs);
    }
    throw new Error('DashScope task polling timeout');
  }

  async process(
    output: 'vertical' | 'horizontal',
    customParams: QwenVideoParams
  ): Promise<URL> {
    const taskId = await this.createTask(customParams.mode, output, customParams);
    return this.pollTask(taskId);
  }
}
