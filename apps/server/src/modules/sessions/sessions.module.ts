import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { EventsModule } from '../events/events.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { IntentRecognitionModule } from '../intent-recognition/intent-recognition.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [
    AgentsModule,
    EventsModule,
    MemoryModule,
    IntentRecognitionModule,
    OrchestratorModule,
    RuntimeModule,
    forwardRef(() => ExecutionModule),
    TasksModule,
    forwardRef(() => WorkflowsModule)
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService]
})
export class SessionsModule {}
