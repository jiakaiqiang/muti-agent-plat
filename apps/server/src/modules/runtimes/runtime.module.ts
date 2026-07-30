import { Module, type OnModuleInit } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentProfileModule } from '../agent-profile/agent-profile.module.js';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodeReaderRuntimeAdapterService } from './code-reader-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';
import { RuntimeController } from './runtime.controller.js';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { RuntimeSmartRouterService } from './runtime-smart-router.service.js';
import { RuntimeService } from './runtime.service.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';
import { CodeSearchTool } from '../tools/builtin/code-search.tool.js';
import { FileReaderTool } from '../tools/builtin/file-reader.tool.js';
import { FileWriterTool } from '../tools/builtin/file-writer.tool.js';
import { TestRunnerTool } from '../tools/builtin/test-runner.tool.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { ToolAuthorityResolverService } from '../tools/tool-authority-resolver.service.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';
import { InvocationResolverService } from '../runtime-routing/invocation-resolver.service.js';
import { WorkspaceToolsService } from './workspace-tools.service.js';
import { WorkdirBriefService } from './streaming/workdir-brief.service.js';
import { WorktreeExecutionModule } from '../worktree-execution/worktree-execution.module.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { CAPABILITY_TOOL_MAPPING } from '../tools/capability-tool-mapping.js';
import { ServerRuntimeWorkerService } from './server-runtime-worker.service.js';

@Module({
  imports: [AgentsModule, AgentProfileModule, CapabilitiesModule, WorktreeExecutionModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    ServerRuntimeWorkerService,
    RuntimeRegistryService,
    RuntimeSmartRouterService,
    TestRunnerRuntimeAdapterService,
    ToolRegistryService,
    ToolAuthorityResolverService,
    ToolInvocationAuditService,
    InvocationResolverService,
    CodeSearchTool,
    FileReaderTool,
    FileWriterTool,
    TestRunnerTool,
    RuntimeModelConfigService,
    MockRuntimeService,
    GenericLlmRuntimeService,
    CodeReaderRuntimeAdapterService,
    CodexRuntimeAdapterService,
    ClaudeCodeRuntimeAdapterService,
    WorkspaceToolsService,
    WorkdirBriefService
  ],
  exports: [
    RuntimeService,
    ServerRuntimeWorkerService,
    WorktreeExecutionModule,
    RuntimeRegistryService,
    RuntimeSmartRouterService,
    TestRunnerRuntimeAdapterService,
    ToolRegistryService,
    ToolAuthorityResolverService,
    InvocationResolverService,
    CodeSearchTool,
    FileReaderTool,
    FileWriterTool,
    TestRunnerTool,
    CodeReaderRuntimeAdapterService,
    RuntimeModelConfigService,
    WorkspaceToolsService,
    WorkdirBriefService
  ]
})
export class RuntimeModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistryService,
    fileReader: FileReaderTool,
    fileWriter: FileWriterTool,
    codeSearch: CodeSearchTool,
    testRunner: TestRunnerTool,
    private readonly persistence: PersistenceService
  ) {
    [fileReader, fileWriter, codeSearch, testRunner].forEach((tool) => registry.registerTool(tool));
  }

  async onModuleInit(): Promise<void> {
    const registry = this.registry;
    const persisted = await this.persistence.syncToolDefinitions(
      registry.listAll().map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        riskLevel: tool.riskLevel,
        inputSchema: tool.inputSchema,
        provider: 'agent-cluster',
        toolType: 'builtin',
        approvalPolicy: tool.riskLevel === 'high' ? 'user_confirmation' : 'none',
        capabilityExternalIds: Object.entries(CAPABILITY_TOOL_MAPPING)
          .filter(([, toolNames]) => toolNames.includes(tool.name))
          .map(([capabilityId]) => capabilityId)
      }))
    );
    if (!persisted) {
      throw new Error('TOOL_CATALOG_PERSISTENCE_FAILED: registered Tool definitions were not committed.');
    }
  }
}
