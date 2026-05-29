import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { SessionsService } from './sessions.service.js';

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('sessions')
  list() {
    return ok({
      items: this.sessions.list(),
      hasMore: false
    });
  }

  @Post('sessions')
  create(
    @Body()
    body: { input: string; agentIds?: string[]; projectId?: string; tokenBudget?: number; knowledgeBaseIds?: string[] }
  ) {
    return this.sessions.create(body).then(ok);
  }

  @Get('sessions/:sessionId')
  detail(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.get(sessionId));
  }

  @Post('sessions/:sessionId/messages')
  sendMessage(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; mentionedAgentIds?: string[] }
  ) {
    return this.sessions.sendMessage(sessionId, body.content, body.mentionedAgentIds).then(ok);
  }

  @Post('sessions/:sessionId/pause')
  pause(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(this.sessions.control(sessionId, 'WAIT_USER_DECISION', body?.reason ?? '用户已暂停会话', body?.confirmationId));
  }

  @Post('sessions/:sessionId/resume')
  resume(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(this.sessions.control(sessionId, 'EXECUTING', body?.reason ?? '用户已继续会话', body?.confirmationId));
  }

  @Post('sessions/:sessionId/cancel')
  cancel(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(this.sessions.control(sessionId, 'CANCELLED', body?.reason ?? '用户已取消会话', body?.confirmationId));
  }

  @Get('sessions/:sessionId/briefs')
  briefs(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.listBriefs(sessionId));
  }

  @Post('sessions/:sessionId/briefs/:briefId/confirm')
  confirmBrief(@Param('sessionId') sessionId: string, @Param('briefId') briefId: string) {
    return this.sessions.confirmBrief(sessionId, briefId).then(ok);
  }

  @Post('sessions/:sessionId/briefs/:briefId/reject')
  rejectBrief(@Param('sessionId') sessionId: string, @Body() body: { reason: string }) {
    return ok(this.sessions.control(sessionId, 'REVISING_BRIEF', body.reason));
  }
}
