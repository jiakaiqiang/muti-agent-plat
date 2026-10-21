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
import { GitHubAuthorizationService } from '../code-hosts/github-authorization.service.js';
import { GitHubCodeHostAdapter } from '../code-hosts/github-code-host.adapter.js';
import { GitRepositoryWorkspaceManager } from '../repository-workspaces/repository-workspace-manager.js';
import { SourcePreparationCoordinator } from './source-preparation-coordinator.js';
import { DeliveryCoordinator } from '../delivery/delivery-coordinator.js';
import { IntentCorrectionService } from '../message-routing/intent-correction.service.js';
import { IntentCorrectionPlannerService } from '../message-routing/intent-correction-planner.service.js';
import { IntentMessagePipelineService } from '../message-routing/intent-message-pipeline.service.js';
import { IntentWorkspaceAuthorityService } from '../message-routing/intent-workspace-authority.service.js';
import { IntentTestAuthorityService } from '../message-routing/intent-test-authority.service.js';
import { SemanticClarificationService } from '../message-routing/semantic-clarification.service.js';
import { IntentAuthorizationRetryService } from '../message-routing/intent-authorization-retry.service.js';
import { IntentRecognitionRetryService } from '../message-routing/intent-recognition-retry.service.js';
import { IntentBriefConfirmationService } from '../message-routing/intent-brief-confirmation.service.js';

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
  providers: [
    SessionsService,
    IntentCorrectionService,
    IntentCorrectionPlannerService,
    IntentMessagePipelineService,
    IntentWorkspaceAuthorityService,
    IntentTestAuthorityService,
    SemanticClarificationService,
    IntentAuthorizationRetryService,
    IntentRecognitionRetryService,
    IntentBriefConfirmationService,
    GitHubCodeHostAdapter,
    GitHubAuthorizationService,
    { provide: GitRepositoryWorkspaceManager, useFactory: () => new GitRepositoryWorkspaceManager() },
    SourcePreparationCoordinator,
    DeliveryCoordinator
  ],
  exports: [SessionsService]
})
export class SessionsModule {}
