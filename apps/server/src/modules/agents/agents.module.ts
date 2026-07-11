import { Module, forwardRef } from '@nestjs/common';
import { AgentProfileModule } from '../agent-profile/agent-profile.module.js';
import { AgentsService } from './agents.service.js';
import { AgentsController } from './agents.controller.js';

@Module({
  imports: [forwardRef(() => AgentProfileModule)],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService]
})
export class AgentsModule {}
