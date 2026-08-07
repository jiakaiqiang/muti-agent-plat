import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AgentCatalogSurface } from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import { AgentsService } from './agents.service.js';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(@Query('surface') surface?: AgentCatalogSurface) {
    const selectedSurface = surface ?? 'management';
    if (!['management', 'chat', 'workflow', 'mention'].includes(selectedSurface)) {
      throw new BadRequestException(`Invalid Agent catalog surface: ${selectedSurface}`);
    }
    return ok(this.agents.listForSurface(selectedSurface));
  }

  @Get(':agentId')
  detail(@Param('agentId') agentId: string) {
    return ok(this.agents.getByIdOrKey(agentId));
  }

  @Post('profile/validate')
  validateProfile(@Body() body: { profileMarkdown: string; capabilityIds?: string[] }) {
    return ok(this.agents.validateProfile(body ?? { profileMarkdown: '' }));
  }

  @Post()
  create(@Body() body: Parameters<AgentsService['create']>[0]) {
    return ok(this.agents.create(body));
  }

  @Patch(':agentId')
  update(@Param('agentId') agentId: string, @Body() body: Parameters<AgentsService['update']>[1]) {
    return ok(this.agents.update(agentId, body));
  }

  @Post(':agentId/knowledge-bases/:knowledgeBaseId')
  bindKnowledge(@Param('agentId') agentId: string, @Param('knowledgeBaseId') knowledgeBaseId: string) {
    return ok({
      agent: this.agents.bindKnowledge(agentId, knowledgeBaseId),
      knowledgeBaseId,
      accessLevel: 'read'
    });
  }

  @Delete(':agentId/knowledge-bases/:knowledgeBaseId')
  unbindKnowledge(@Param('agentId') agentId: string, @Param('knowledgeBaseId') knowledgeBaseId: string) {
    return ok({
      agent: this.agents.unbindKnowledge(agentId, knowledgeBaseId),
      knowledgeBaseId,
      removed: true
    });
  }
}
