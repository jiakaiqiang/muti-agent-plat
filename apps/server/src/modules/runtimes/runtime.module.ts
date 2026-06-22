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
import { FileReaderTool } from '../tools/builtin/file-reader.tool.js';
import { FileWriterTool } from '../tools/builtin/file-writer.tool.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';

@Module({
  imports: [AgentsModule, CapabilitiesModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    RuntimeRegistryService,
    FileReaderTool,
    FileWriterTool,
    ToolRegistryService,
    RuntimeSmartRouterService,
    CodeReaderRuntimeAdapterService,
    RuntimeModelConfigService,
    MockRuntimeService,
    GenericLlmRuntimeService,
    CodexRuntimeAdapterService,
    ClaudeCodeRuntimeAdapterService
  ],
  exports: [RuntimeService, RuntimeRegistryService, RuntimeSmartRouterService, ToolRegistryService, FileReaderTool, FileWriterTool, CodeReaderRuntimeAdapterService, RuntimeModelConfigService]
})
export class RuntimeModule {}
