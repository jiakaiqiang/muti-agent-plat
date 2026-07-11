import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AutopilotController } from './autopilot.controller.js';
import { AutopilotService } from './autopilot.service.js';

@Module({
  imports: [SessionsModule],
  controllers: [AutopilotController],
  providers: [AutopilotService],
  exports: [AutopilotService]
})
export class AutopilotModule {}
