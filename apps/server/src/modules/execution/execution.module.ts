import { Module, forwardRef } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ExecutionService } from './execution.service.js';

@Module({
  imports: [OrchestratorModule, forwardRef(() => QueueModule)],
  providers: [ExecutionService],
  exports: [ExecutionService]
})
export class ExecutionModule {}
