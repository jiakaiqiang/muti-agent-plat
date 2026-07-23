import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { MaintenanceCoordinatorService } from './maintenance-coordinator.service.js';

@Module({
  imports: [ExecutionModule, QueueModule, WorkspacesModule],
  providers: [MaintenanceCoordinatorService],
  exports: [MaintenanceCoordinatorService]
})
export class MaintenanceModule {}
