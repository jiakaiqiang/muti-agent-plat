import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module.js';
import { ArtifactsModule } from './modules/artifacts/artifacts.module.js';
import { CapabilitiesModule } from './modules/capabilities/capabilities.module.js';
import { DebugModule } from './modules/debug/debug.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';
import { ModelsModule } from './modules/models/models.module.js';
import { KnowledgeModule } from './modules/rag/knowledge.module.js';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { PersistenceModule } from './modules/persistence/persistence.module.js';
import { RuntimeModule } from './modules/runtimes/runtime.module.js';
import { SessionsModule } from './modules/sessions/sessions.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { UserMessageRouterModule } from './modules/user-message-router/user-message-router.module.js';

@Module({
  imports: [
    PersistenceModule,
    CapabilitiesModule,
    AgentsModule,
    ModelsModule,
    EventsModule,
    MemoryModule,
    TasksModule,
    RuntimeModule,
    UserMessageRouterModule,
    OrchestratorModule,
    OpsModule,
    DebugModule,
    KnowledgeModule,
    ArtifactsModule,
    SessionsModule
  ]
})
export class AppModule {}
