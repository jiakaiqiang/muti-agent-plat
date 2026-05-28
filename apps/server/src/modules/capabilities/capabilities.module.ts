import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { CapabilityAuditService } from './capability-audit.service.js';
import { CapabilitiesController } from './capabilities.controller.js';
import { CapabilitiesService } from './capabilities.service.js';

@Module({
  imports: [EventsModule],
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService, CapabilityAuditService],
  exports: [CapabilitiesService]
})
export class CapabilitiesModule {}
