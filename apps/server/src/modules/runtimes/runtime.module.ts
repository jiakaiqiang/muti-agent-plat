import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { EventsModule } from '../events/events.module.js';
import { ModelsModule } from '../models/models.module.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeController } from './runtime.controller.js';
import { RuntimeService } from './runtime.service.js';
import { ToolExecutorService } from './tool-executor.service.js';

@Module({
  imports: [CapabilitiesModule, EventsModule, ModelsModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    MockRuntimeService,
    GenericLlmRuntimeService,
    CodexRuntimeAdapterService,
    ClaudeCodeRuntimeAdapterService,
    ToolExecutorService
  ],
  exports: [RuntimeService, ToolExecutorService]
})
export class RuntimeModule {}
