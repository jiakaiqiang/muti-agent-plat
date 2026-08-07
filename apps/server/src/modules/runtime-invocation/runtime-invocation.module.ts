import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { RuntimeInvocationService } from './runtime-invocation.service.js';

@Module({
  imports: [RuntimeModule],
  providers: [RuntimeInvocationService],
  exports: [RuntimeInvocationService]
})
export class RuntimeInvocationModule {}
