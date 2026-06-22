import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';
import { RuntimeController } from './runtime.controller.js';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { RuntimeService } from './runtime.service.js';
import { FileReaderTool } from '../tools/builtin/file-reader.tool.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';

@Module({
  imports: [AgentsModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    RuntimeRegistryService,
    FileReaderTool,
    ToolRegistryService,
    RuntimeModelConfigService,
    MockRuntimeService,
    GenericLlmRuntimeService,
    CodexRuntimeAdapterService,
    ClaudeCodeRuntimeAdapterService
  ],
  exports: [RuntimeService, RuntimeRegistryService, ToolRegistryService, FileReaderTool, RuntimeModelConfigService]
})
export class RuntimeModule {}
