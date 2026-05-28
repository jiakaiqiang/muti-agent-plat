import { Module } from '@nestjs/common';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeService } from './runtime.service.js';

@Module({
  providers: [RuntimeService, MockRuntimeService],
  exports: [RuntimeService]
})
export class RuntimeModule {}
