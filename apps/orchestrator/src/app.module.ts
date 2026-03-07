import { Module } from '@nestjs/common';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';
import { EmailActivity } from '@gitroom/orchestrator/activities/email.activity';
import { ContentFactoryActivity } from '@gitroom/orchestrator/activities/content-factory.activity';
import { MaterialsModule } from '@gitroom/nestjs-libraries/materials/materials.module';
import { AnalysisService } from '@gitroom/orchestrator/activities/analysis.service';
import { VideoModule } from '@gitroom/nestjs-libraries/videos/video.module';

const activities = [
  PostActivity,
  AutopostService,
  EmailActivity,
  ContentFactoryActivity,
  AnalysisService,
];
@Module({
  imports: [
    DatabaseModule,
    MaterialsModule,
    VideoModule,
    getTemporalModule(true, require.resolve('./workflows'), activities),
  ],
  controllers: [],
  providers: [...activities],
  get exports() {
    return [...this.providers, ...this.imports];
  },
})
export class AppModule {}
