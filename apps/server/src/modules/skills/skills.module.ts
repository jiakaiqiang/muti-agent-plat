import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentSkillsController, SkillsController } from './skills.controller.js';
import { SkillsService } from './skills.service.js';

@Module({
  imports: [forwardRef(() => AgentsModule)],
  controllers: [SkillsController, AgentSkillsController],
  providers: [SkillsService],
  exports: [SkillsService]
})
export class SkillsModule {}
