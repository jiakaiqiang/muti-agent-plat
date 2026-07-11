import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { SkillsService, type SkillInput } from './skills.service.js';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list() {
    return ok(this.skills.list());
  }

  @Get(':skillId')
  detail(@Param('skillId') skillId: string) {
    return ok(this.skills.get(skillId));
  }

  @Get(':skillId/references')
  references(@Param('skillId') skillId: string) {
    return ok({ agents: this.skills.referencingAgents(skillId) });
  }

  @Post()
  create(@Body() body: SkillInput) {
    return ok(this.skills.create(body));
  }

  @Patch(':skillId')
  update(@Param('skillId') skillId: string, @Body() body: Partial<SkillInput>) {
    return ok(this.skills.update(skillId, body));
  }

  @Delete(':skillId')
  remove(@Param('skillId') skillId: string) {
    return ok(this.skills.remove(skillId));
  }
}

@Controller('agents')
export class AgentSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Post(':agentId/skills/:skillId')
  bind(@Param('agentId') agentId: string, @Param('skillId') skillId: string) {
    return ok(this.skills.bind(agentId, skillId));
  }

  @Delete(':agentId/skills/:skillId')
  unbind(@Param('agentId') agentId: string, @Param('skillId') skillId: string) {
    return ok(this.skills.unbind(agentId, skillId));
  }
}
