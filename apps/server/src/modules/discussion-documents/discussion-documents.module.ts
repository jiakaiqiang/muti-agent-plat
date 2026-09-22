import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { EventsModule } from '../events/events.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { DiscussionDocumentsService } from './discussion-documents.service.js';

@Module({
  imports: [ArtifactsModule, EventsModule, TasksModule],
  providers: [DiscussionDocumentsService],
  exports: [DiscussionDocumentsService]
})
export class DiscussionDocumentsModule {}
