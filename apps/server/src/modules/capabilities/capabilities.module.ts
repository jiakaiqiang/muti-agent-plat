import { Module, forwardRef } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { CapabilityAuditService } from './capability-audit.service.js';
import { CapabilitiesController } from './capabilities.controller.js';
import { CapabilitiesService } from './capabilities.service.js';

@Module({
  imports: [EventsModule, forwardRef(() => AgentsModule)],
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService, CapabilityAuditService],
  exports: [CapabilitiesService, CapabilityAuditService]
})
export class CapabilitiesModule {}
