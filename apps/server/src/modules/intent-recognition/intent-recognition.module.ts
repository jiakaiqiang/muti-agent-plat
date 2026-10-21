import { Module } from '@nestjs/common';
import { IntentRecognitionService } from './intent-recognition.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { RuntimeInvocationModule } from '../runtime-invocation/runtime-invocation.module.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';
import { EventsModule } from '../events/events.module.js';
import { DeterministicCommandGuardService } from './deterministic-command-guard.service.js';
import { IntentUnderstandingRoutingService } from './intent-understanding-routing.service.js';

@Module({
  imports: [AgentsModule, ContextManagementModule, RuntimeInvocationModule, EventsModule],
  providers: [DeterministicCommandGuardService, IntentRecognitionService, SemanticIntentRouterService, IntentUnderstandingRoutingService],
  exports: [DeterministicCommandGuardService, IntentRecognitionService, SemanticIntentRouterService, IntentUnderstandingRoutingService]
})
export class IntentRecognitionModule {}
