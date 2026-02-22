import { Module } from '@nestjs/common';
import { MediaCrawlerService } from '@gitroom/nestjs-libraries/materials/materials.crawler.service';
import { MaterialsEventsService } from '@gitroom/nestjs-libraries/materials/materials.events.service';
import { MaterialsQueueService } from '@gitroom/nestjs-libraries/materials/materials.queue.service';
import { MaterialsService } from '@gitroom/nestjs-libraries/materials/materials.service';
import { MaterialsAnalysisService } from '@gitroom/nestjs-libraries/materials/materials.analysis.service';
import { MaterialsAnalysisQueueService } from '@gitroom/nestjs-libraries/materials/materials.analysis.queue.service';

@Module({
  providers: [
    MediaCrawlerService,
    MaterialsEventsService,
    MaterialsQueueService,
    MaterialsService,
    MaterialsAnalysisService,
    MaterialsAnalysisQueueService,
  ],
  exports: [
    MediaCrawlerService,
    MaterialsEventsService,
    MaterialsQueueService,
    MaterialsService,
    MaterialsAnalysisService,
    MaterialsAnalysisQueueService,
  ],
})
export class MaterialsModule { }
