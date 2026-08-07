import { Module } from '@nestjs/common';
import { IntentRecognitionService } from './intent-recognition.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { RuntimeInvocationModule } from '../runtime-invocation/runtime-invocation.module.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';

@Module({
  imports: [AgentsModule, ContextManagementModule, RuntimeInvocationModule],
  providers: [IntentRecognitionService, SemanticIntentRouterService],
  exports: [IntentRecognitionService, SemanticIntentRouterService]
})
export class IntentRecognitionModule {}
