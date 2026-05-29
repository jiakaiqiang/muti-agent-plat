import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { MemoryScope } from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import { MemoryService } from './memory.service.js';

@Controller('sessions/:sessionId/memories')
export class MemoryController {
  constructor(private readonly memories: MemoryService) {}

  @Get()
  list(@Param('sessionId') sessionId: string, @Query('q') query?: string, @Query('agentId') agentId?: string) {
    const items = query
      ? this.memories.search(sessionId, query, agentId)
      : this.memories.list(sessionId).filter((memory) => !agentId || !memory.agentId || memory.agentId === agentId);
    return ok({ items, hasMore: false });
  }

  @Post()
  create(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; scope?: MemoryScope; agentId?: string; sourceEventId?: string; confidence?: number }
  ) {
    return ok(
      this.memories.create({
        sessionId,
        content: body.content,
        scope: body.scope,
        agentId: body.agentId,
        sourceEventId: body.sourceEventId,
        confidence: body.confidence
      })
    );
  }
}
