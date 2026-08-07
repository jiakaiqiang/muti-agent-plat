import { Module } from '@nestjs/common';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { EventsModule } from '../events/events.module.js';
import { MessageIngressService } from './message-ingress.service.js';
import { RouteApplicationService } from './route-application.service.js';

@Module({
  imports: [ContextManagementModule, EventsModule],
  providers: [MessageIngressService, RouteApplicationService],
  exports: [MessageIngressService, RouteApplicationService]
})
export class MessageRoutingModule {}
