import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { EventsModule } from '../events/events.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { KnowledgeModule } from '../rag/knowledge.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ContextRouterService } from './context-router.service.js';
import { OrchestratorService } from './orchestrator.service.js';
import { ProjectMapService } from './project-map.service.js';

@Module({
  imports: [
    AgentsModule,
    EventsModule,
    RuntimeModule,
    TasksModule,
    KnowledgeModule,
    MemoryModule,
    ArtifactsModule,
    CapabilitiesModule
  ],
  providers: [ContextRouterService, ProjectMapService, OrchestratorService],
  exports: [ContextRouterService, ProjectMapService, OrchestratorService]
})
export class OrchestratorModule {}
