import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
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
import { WorkspaceToolsService } from './workspace-tools.service.js';

@Module({
  imports: [AgentsModule, CapabilitiesModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    RuntimeRegistryService,
    RuntimeSmartRouterService,
    TestRunnerRuntimeAdapterService,
    ToolRegistryService,
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
    WorkspaceToolsService
  ],
  exports: [
    RuntimeService,
    RuntimeRegistryService,
    RuntimeSmartRouterService,
    TestRunnerRuntimeAdapterService,
    ToolRegistryService,
    CodeSearchTool,
    FileReaderTool,
    FileWriterTool,
    TestRunnerTool,
    CodeReaderRuntimeAdapterService,
    RuntimeModelConfigService,
    WorkspaceToolsService
  ]
})
export class RuntimeModule {}
