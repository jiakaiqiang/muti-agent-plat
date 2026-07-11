import { Module, forwardRef } from '@nestjs/common';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import {
  AgentProfileCompilerService,
  PROFILE_CAPABILITY_REPOSITORY,
  PROFILE_SKILL_REPOSITORY,
  type ProfileCapabilityRepository,
  type ProfileSkillRepository
} from './agent-profile-compiler.service.js';
import { SkillsService } from '../skills/skills.service.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';

@Module({
  imports: [forwardRef(() => SkillsModule), CapabilitiesModule],
  providers: [
    {
      provide: PROFILE_SKILL_REPOSITORY,
      inject: [SkillsService],
      useFactory: (skills: SkillsService): ProfileSkillRepository => ({
        list: () => skills.list(),
        findById: (id) => skills.list().find((s) => s.id === id),
        findByKey: (key) => skills.findByKey(key)
      })
    },
    {
      provide: PROFILE_CAPABILITY_REPOSITORY,
      inject: [CapabilitiesService],
      useFactory: (capabilities: CapabilitiesService): ProfileCapabilityRepository => ({
        list: () => capabilities.listDefinitions(),
        findById: (id) => capabilities.findDefinitionById(id),
        findByKey: (key) => capabilities.findDefinitionByKey(key)
      })
    },
    AgentProfileCompilerService
  ],
  exports: [AgentProfileCompilerService]
})
export class AgentProfileModule {}

