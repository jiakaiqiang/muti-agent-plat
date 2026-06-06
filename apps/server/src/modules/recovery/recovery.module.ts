import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { RecoveryService } from './recovery.service.js';

@Module({
  imports: [SessionsModule, TasksModule, OrchestratorModule, ExecutionModule],
  providers: [RecoveryService]
})
export class RecoveryModule {}
