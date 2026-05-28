import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { EventsModule } from '../events/events.module.js';
import { KnowledgeModule } from '../rag/knowledge.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { OrchestratorService } from './orchestrator.service.js';

@Module({
  imports: [AgentsModule, EventsModule, RuntimeModule, TasksModule, KnowledgeModule],
  providers: [OrchestratorService],
  exports: [OrchestratorService]
})
export class OrchestratorModule {}
