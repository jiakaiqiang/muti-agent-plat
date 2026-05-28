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
  create(@Body() body: Record<string, unknown>) {
    return ok({
      ...body,
      id: crypto.randomUUID(),
      status: 'active'
    });
  }

  @Patch(':agentId')
  update(@Param('agentId') agentId: string, @Body() body: Record<string, unknown>) {
    return ok({
      ...this.agents.getByIdOrKey(agentId),
      ...body
    });
  }

  @Post(':agentId/knowledge-bases/:knowledgeBaseId')
  bindKnowledge(@Param('agentId') agentId: string, @Param('knowledgeBaseId') knowledgeBaseId: string) {
    return ok({ agentId, knowledgeBaseId, accessLevel: 'read' });
  }

  @Delete(':agentId/knowledge-bases/:knowledgeBaseId')
  unbindKnowledge(@Param('agentId') agentId: string, @Param('knowledgeBaseId') knowledgeBaseId: string) {
    return ok({ agentId, knowledgeBaseId, removed: true });
  }
}
