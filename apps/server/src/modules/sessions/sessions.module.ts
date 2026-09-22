import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { EventsModule } from '../events/events.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { IntentRecognitionModule } from '../intent-recognition/intent-recognition.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { FileRevisionsModule } from '../file-revisions/file-revisions.module.js';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { MessageRoutingModule } from '../message-routing/message-routing.module.js';
import { DiscussionDocumentsModule } from '../discussion-documents/discussion-documents.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';

@Module({
  imports: [
    AgentsModule,
    ArtifactsModule,
    EventsModule,
    MemoryModule,
    ContextManagementModule,
    MessageRoutingModule,
    DiscussionDocumentsModule,
    IntentRecognitionModule,
    OrchestratorModule,
    RuntimeModule,
    CapabilitiesModule,
    forwardRef(() => ExecutionModule),
    TasksModule,
    FileRevisionsModule,
    forwardRef(() => AttachmentsModule),
    forwardRef(() => WorkflowsModule)
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService]
})
export class SessionsModule {}
