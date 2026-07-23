import { BadRequestException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import type {
  PostReviewAction,
  RuntimePreference,
  SessionWorkingDirectory,
  WorkspaceSnapshot
} from '@agent-cluster/shared';
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
    body: {
      input: string;
      agentIds?: string[];
      projectId?: string;
      tokenBudget?: number;
      knowledgeBaseIds?: string[];
      workingDirectory?: SessionWorkingDirectory;
      workspaceSnapshot?: WorkspaceSnapshot;
      runtimePreference?: RuntimePreference;
    }
  ) {
    assertSessionCreateContract(body);
    return this.sessions.create(body).then(ok);
  }

  @Get('sessions/:sessionId')
  detail(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.get(sessionId));
  }

  @Post('sessions/:sessionId/workspace/snapshot')
  refreshWorkspaceSnapshot(
    @Param('sessionId') sessionId: string,
    @Body() body: { workspaceId: string; workspaceSnapshot: WorkspaceSnapshot }
  ) {
    if (!body?.workspaceId || !body.workspaceSnapshot) {
      throw new BadRequestException('workspaceId and workspaceSnapshot are required.');
    }
    return ok(this.sessions.refreshBrowserWorkspaceSnapshot(sessionId, body.workspaceId, body.workspaceSnapshot));
  }

  @Delete('sessions/:sessionId')
  async delete(@Param('sessionId') sessionId: string) {
    return ok(await this.sessions.delete(sessionId));
  }

  @Post('sessions/:sessionId/messages')
  sendMessage(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; mentionedAgentIds?: string[] }
  ) {
    return this.sessions.sendMessage(sessionId, body.content, body.mentionedAgentIds).then(ok);
  }

  @Post('sessions/:sessionId/memories/confirm')
  confirmMemory(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; confirmationId?: string; sourceEventId?: string; confidence?: number }
  ) {
    return ok(this.sessions.confirmMemory(sessionId, body));
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

  @Post('sessions/:sessionId/post-review/actions')
  async resolvePostReviewAction(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; action: PostReviewAction['action'] }
  ) {
    return ok(await this.sessions.resolvePostReviewAction(sessionId, body));
  }

  @Get('sessions/:sessionId/briefs')
  briefs(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.listBriefs(sessionId));
  }

  @Post('sessions/:sessionId/briefs/:briefId/confirm')
  confirmBrief(@Param('sessionId') sessionId: string, @Param('briefId') briefId: string) {
    return this.sessions.confirmBrief(sessionId, briefId).then(ok);
  }

  @Post('sessions/:sessionId/workflow/select')
  async selectWorkflow(
    @Param('sessionId') sessionId: string,
    @Body() body: { workflowId: string; workflowVersion?: number; confirmationId: string }
  ) {
    return ok(await this.sessions.selectWorkflow(sessionId, body));
  }

  @Post('sessions/:sessionId/workspace/empty-decision')
  async resolveEmptyWorkspaceDecision(
    @Param('sessionId') sessionId: string,
    @Body() body: {
      confirmationId: string;
      decision: 'initialize_project' | 'reselect_workspace' | 'cancel';
    }
  ) {
    return ok(await this.sessions.resolveEmptyWorkspaceDecision(sessionId, body));
  }

  @Post('sessions/:sessionId/workflow/steps/:taskId/decision')
  resolveWorkflowStep(
    @Param('sessionId') sessionId: string,
    @Param('taskId') taskId: string,
    @Body() body: { confirmationId: string; decision: 'approve' | 'revise'; instruction?: string }
  ) {
    return ok(this.sessions.resolveWorkflowStep(sessionId, { ...body, taskId }));
  }

  @Post('sessions/:sessionId/briefs/:briefId/reject')
  rejectBrief(
    @Param('sessionId') sessionId: string,
    @Param('briefId') briefId: string,
    @Body() body: { reason?: string; userMessage?: string; confirmationId?: string; assignedAgentKeys?: string[] }
  ) {
    return ok(this.sessions.reviseBrief(sessionId, briefId, body));
  }

  @Post('sessions/:sessionId/notifications/feishu/decision')
  decideFeishuNotification(
    @Param('sessionId') sessionId: string,
    @Body()
    body: {
      confirmationId?: string;
      notificationDraftArtifactId?: string;
      decision: 'send_notification' | 'skip_notification';
    }
  ) {
    return ok(this.sessions.decideFeishuNotification(sessionId, body));
  }

  @Post('sessions/:sessionId/reports/local-save/decision')
  decideLocalReportSave(
    @Param('sessionId') sessionId: string,
    @Body()
    body: {
      confirmationId: string;
      artifactId: string;
      decision: 'save_local' | 'keep_in_session';
    }
  ) {
    if (!body.confirmationId || !body.artifactId || !['save_local', 'keep_in_session'].includes(body.decision)) {
      throw new BadRequestException('A valid report save confirmation decision is required.');
    }
    return this.sessions.decideLocalReportSave(sessionId, body).then(ok);
  }
}

const SESSION_CREATE_FIELDS = new Set([
  'input',
  'agentIds',
  'projectId',
  'tokenBudget',
  'knowledgeBaseIds',
  'workingDirectory',
  'workspaceSnapshot',
  'runtimePreference'
]);

export function assertSessionCreateContract(body: unknown): asserts body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Session create body must be an object.');
  }
  const unsupportedFields = Object.keys(body).filter((field) => !SESSION_CREATE_FIELDS.has(field));
  if (unsupportedFields.length) {
    throw new BadRequestException(
      `Unsupported Session create fields: ${unsupportedFields.sort().join(', ')}. Use the v2 runtimePreference contract.`
    );
  }
}
