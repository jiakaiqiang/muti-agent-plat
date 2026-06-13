import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { EventsModule } from '../events/events.module.js';
import { RuntimeModule } from '../runtimes/runtime.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { DebugController } from './debug.controller.js';

@Module({
  imports: [ArtifactsModule, EventsModule, RuntimeModule, SessionsModule],
  controllers: [DebugController]
})
export class DebugModule {}
