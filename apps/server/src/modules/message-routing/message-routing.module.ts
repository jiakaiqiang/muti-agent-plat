import { Module } from '@nestjs/common';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { EventsModule } from '../events/events.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { MessageIngressService } from './message-ingress.service.js';
import { RouteApplicationService } from './route-application.service.js';
import { CommandStateResolverService } from './command-state-resolver.service.js';
import { CommandApplicationService } from './command-application.service.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { RuntimeInvocationModule } from '../runtime-invocation/runtime-invocation.module.js';
import { IntentAnswerExecutorService } from './intent-answer-executor.service.js';
import { IntentTestExecutorService } from './intent-test-executor.service.js';
import { IntentBriefStoreService } from './intent-brief-store.service.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { IntentBriefRetryService } from './intent-brief-retry.service.js';
import { IntentResumeControlService } from './intent-resume-control.service.js';

@Module({
  imports: [ContextManagementModule, EventsModule, AgentsModule, RuntimeModule, RuntimeInvocationModule],
  providers: [CommandStateResolverService, CommandApplicationService, MessageIngressService, RouteApplicationService, IntentPlanCommitService, IntentAnswerExecutorService, IntentTestExecutorService, IntentBriefStoreService, IntentBriefExecutorService, IntentBriefRetryService, IntentResumeControlService],
  exports: [CommandStateResolverService, CommandApplicationService, MessageIngressService, RouteApplicationService, IntentPlanCommitService, IntentAnswerExecutorService, IntentTestExecutorService, IntentBriefExecutorService, IntentBriefRetryService, IntentResumeControlService]
})
export class MessageRoutingModule {}
