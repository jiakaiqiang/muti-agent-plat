import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { EventsModule } from '../events/events.module.js';
import { ContextManagementModule } from '../context-management/context-management.module.js';
import { RecoveryService } from './recovery.service.js';
import { LegacyWorkItemMigrationService } from './legacy-workitem-migration.service.js';

@Module({
  imports: [SessionsModule, RuntimeModule, EventsModule, ContextManagementModule],
  providers: [RecoveryService, LegacyWorkItemMigrationService]
})
export class RecoveryModule {}
