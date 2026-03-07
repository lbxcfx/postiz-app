import { Global, Module } from '@nestjs/common';
import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { QwenVideo } from '@gitroom/nestjs-libraries/videos/qwen-video/qwen.video';
import { Veo3 } from '@gitroom/nestjs-libraries/videos/veo3/veo3';

@Global()
@Module({
  providers: [ImagesSlides, QwenVideo, Veo3, VideoManager],
  get exports() {
    return this.providers;
  },
})
export class VideoModule {}
