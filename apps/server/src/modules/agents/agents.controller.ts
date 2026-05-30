import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { AgentsService } from './agents.service.js';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list() {
    return ok(this.agents.list());
  }

  @Get(':agentId')
  detail(@Param('agentId') agentId: string) {
    return ok(this.agents.getByIdOrKey(agentId));
  }

  @Post()
  create(@Body() body: Parameters<AgentsService['create']>[0]) {
    return ok(this.agents.create(body));
  }

  @Delete(':agentId')
  remove(@Param('agentId') agentId: string) {
    return ok(this.agents.remove(agentId));
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
