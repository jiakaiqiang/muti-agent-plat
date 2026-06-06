import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { KnowledgeService } from './knowledge.service.js';

@Controller('knowledge-bases')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list() {
    return ok(this.knowledge.list());
  }

  @Post()
  create(@Body() body: { name: string; scope: 'global' | 'project' | 'session' | 'agent' | 'role_type' }) {
    return ok(this.knowledge.createBase(body));
  }

  @Post(':knowledgeBaseId/documents')
  createDocument(
    @Param('knowledgeBaseId') knowledgeBaseId: string,
    @Body() body: { title: string; sourceType: 'text' | 'markdown' | 'file' | 'feishu_doc'; sourceUri?: string; content?: string }
  ) {
    return ok(this.knowledge.createDocument(knowledgeBaseId, body));
  }

  @Post(':knowledgeBaseId/search')
  search(@Param('knowledgeBaseId') knowledgeBaseId: string, @Body() body: { query: string }) {
    return ok({ chunks: this.knowledge.search(knowledgeBaseId, body.query) });
  }
}
