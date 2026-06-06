import { Module, forwardRef } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ExecutionQueue } from './execution.queue.js';
import { ExecutionWorker } from './execution.worker.js';

@Module({
  imports: [OrchestratorModule, TasksModule, forwardRef(() => SessionsModule)],
  providers: [ExecutionQueue, ExecutionWorker],
  exports: [ExecutionQueue]
})
export class QueueModule {}
