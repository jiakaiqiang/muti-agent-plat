import { Module } from '@nestjs/common';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { EventsModule } from '../events/events.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { MessageIngressService } from './message-ingress.service.js';
import { RouteApplicationService } from './route-application.service.js';
import { CommandStateResolverService } from './command-state-resolver.service.js';
import { CommandApplicationService } from './command-application.service.js';

@Module({
  imports: [ContextManagementModule, EventsModule, AgentsModule],
  providers: [CommandStateResolverService, CommandApplicationService, MessageIngressService, RouteApplicationService],
  exports: [CommandStateResolverService, CommandApplicationService, MessageIngressService, RouteApplicationService]
})
export class MessageRoutingModule {}
