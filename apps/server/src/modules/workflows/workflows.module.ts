import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { EventsModule } from '../events/events.module.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowRunsController } from './workflow-runs.controller.js';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [AgentsModule, EventsModule, forwardRef(() => ExecutionModule), TasksModule],
  controllers: [WorkflowsController, WorkflowRunsController],
  providers: [WorkflowsService, WorkflowRuntimeService],
  exports: [WorkflowsService, WorkflowRuntimeService]
})
export class WorkflowsModule {}
