import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module.js';
import { AgentProfileModule } from './modules/agent-profile/agent-profile.module.js';
import { ArtifactsModule } from './modules/artifacts/artifacts.module.js';
import { CapabilitiesModule } from './modules/capabilities/capabilities.module.js';
import { DebugModule } from './modules/debug/debug.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { ExecutionModule } from './modules/execution/execution.module.js';
import { IntentRecognitionModule } from './modules/intent-recognition/intent-recognition.module.js';
import { RecoveryModule } from './modules/recovery/recovery.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';
import { KnowledgeModule } from './modules/rag/knowledge.module.js';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { PersistenceModule } from './modules/persistence/persistence.module.js';
import { QueueModule } from './modules/queue/queue.module.js';
import { RuntimeModule } from './modules/runtimes/runtime.module.js';
import { SessionsModule } from './modules/sessions/sessions.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { SkillsModule } from './modules/skills/skills.module.js';
import { AutopilotModule } from './modules/autopilot/autopilot.module.js';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';
import { LocalRuntimeModule } from './modules/local-runtime/local-runtime.module.js';
import { MaintenanceModule } from './modules/persistence/maintenance.module.js';
import { WorkflowsModule } from './modules/workflows/workflows.module.js';

@Module({
  imports: [
    PersistenceModule,
    CapabilitiesModule,
    AgentProfileModule,
    AgentsModule,
    EventsModule,
    MemoryModule,
    TasksModule,
    SkillsModule,
    AutopilotModule,
    WorkspacesModule,
    LocalRuntimeModule,
    WorkflowsModule,
    RuntimeModule,
    IntentRecognitionModule,
    OrchestratorModule,
    OpsModule,
    QueueModule,
    DebugModule,
    KnowledgeModule,
    ArtifactsModule,
    SessionsModule,
    ExecutionModule,
    RecoveryModule,
    MaintenanceModule
  ]
})
export class AppModule {}
