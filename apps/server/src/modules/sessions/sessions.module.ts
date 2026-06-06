import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { EventsModule } from '../events/events.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { UserMessageRouterModule } from '../user-message-router/user-message-router.module.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [
    AgentsModule,
    EventsModule,
    MemoryModule,
    UserMessageRouterModule,
    OrchestratorModule,
    forwardRef(() => ExecutionModule),
    TasksModule
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService]
})
export class SessionsModule {}
