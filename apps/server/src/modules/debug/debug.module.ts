import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { DebugController } from './debug.controller.js';

@Module({
  imports: [EventsModule, RuntimeModule],
  controllers: [DebugController]
})
export class DebugModule {}
