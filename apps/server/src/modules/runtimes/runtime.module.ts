import { Module } from '@nestjs/common';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeController } from './runtime.controller.js';
import { RuntimeService } from './runtime.service.js';

@Module({
  controllers: [RuntimeController],
  providers: [RuntimeService, MockRuntimeService, GenericLlmRuntimeService],
  exports: [RuntimeService]
})
export class RuntimeModule {}
