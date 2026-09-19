import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import crypto from 'node:crypto';
import { ok } from '../../common/api-response.js';
import type {
  CaptureFileRevisionBaselineInput,
  CreateFileRevisionRunInput,
  DecideFileRevisionInput,
  ReprocessFileRevisionInput,
  ResolveWorkspaceWritebackInput,
  ResolveFileRevisionFailureInput,
  RetryInterruptedFileRevisionInput,
  SaveFileRevisionDraftInput,
  PostReviewAction,
  RuntimePreference,
  SessionWorkingDirectory
} from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('sessions')
  list(@Query('visibility') visibility?: 'active' | 'deleted' | 'all') {
    if (visibility && !['active', 'deleted', 'all'].includes(visibility)) {
      throw new BadRequestException('visibility must be active, deleted or all.');
    }
    return ok({
      items: this.sessions.list(visibility ?? 'active'),
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
      runtimePreference?: RuntimePreference;
    }
  ) {
    assertSessionCreateContract(body);
    return this.sessions.create(body).then(ok);
  }

  @Get('sessions/:sessionId')
  detail(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.getIncludingDeleted(sessionId));
  }

  @Get('sessions/:sessionId/lifecycle')
  @Header('Cache-Control', 'no-store')
  lifecycle(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.lifecycleState(sessionId));
  }

  @Get('sessions/:sessionId/stop-state')
  @Header('Cache-Control', 'no-store')
  stopState(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.stopState(sessionId));
  }

  @Get('sessions/:sessionId/work-items')
  workItems(@Param('sessionId') sessionId: string) {
    return ok({ items: this.sessions.listWorkItems(sessionId), hasMore: false });
  }

  @Get('sessions/:sessionId/work-items/:workItemId')
  workItem(
    @Param('sessionId') sessionId: string,
    @Param('workItemId') workItemId: string
  ) {
    return ok(this.sessions.getWorkItem(sessionId, workItemId));
  }

  @Post('sessions/:sessionId/work-items/:workItemId/activate')
  async activateWorkItem(
    @Param('sessionId') sessionId: string,
    @Param('workItemId') workItemId: string
  ) {
    return ok(await this.sessions.activateWorkItem(sessionId, workItemId));
  }

  @Get('sessions/:sessionId/decisions')
  decisions(@Param('sessionId') sessionId: string) {
    return ok({ items: this.sessions.listDecisions(sessionId), hasMore: false });
  }

  @Get('sessions/:sessionId/message-routings/:routingId')
  messageRouting(
    @Param('sessionId') sessionId: string,
    @Param('routingId') routingId: string
  ) {
    return ok(this.sessions.getIntentRouting(sessionId, routingId));
  }

  @Post('sessions/:sessionId/message-routings/:routingId/clarify')
  async clarifyMessageRouting(
    @Param('sessionId') sessionId: string,
    @Param('routingId') routingId: string,
    @Body() body: {
      choice: 'continue_current' | 'related_new' | 'independent_new';
      confirmationId?: string;
    }
  ) {
    if (!['continue_current', 'related_new', 'independent_new'].includes(body.choice)) {
      throw new BadRequestException('Invalid intent clarification choice.');
    }
    return ok(await this.sessions.clarifyIntentRouting(sessionId, routingId, body));
  }

  @Get('sessions/:sessionId/debug/intent-routing')
  debugIntentRouting(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.debugIntentRouting(sessionId));
  }

  @Get('sessions/:sessionId/file-revisions')
  fileRevisions(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.fileRevisionState(sessionId));
  }

  @Post('sessions/:sessionId/file-revisions/baselines')
  async captureFileRevisionBaseline(
    @Param('sessionId') sessionId: string,
    @Body() body: CaptureFileRevisionBaselineInput
  ) {
    assertCaptureFileRevisionBaselineInput(body);
    return ok(await this.sessions.captureFileRevisionBaseline(sessionId, body));
  }

  @Post('sessions/:sessionId/file-revisions')
  async startFileRevision(
    @Param('sessionId') sessionId: string,
    @Body() body: CreateFileRevisionRunInput
  ) {
    assertCreateFileRevisionRunInput(body);
    return ok(await this.sessions.startFileRevision(sessionId, body));
  }

  @Get('sessions/:sessionId/file-revisions/:revisionId/candidate')
  @Header('Cache-Control', 'no-store')
  fileRevisionCandidate(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string
  ) {
    return ok(this.sessions.fileRevisionCandidate(sessionId, revisionId));
  }

  @Get('sessions/:sessionId/file-revisions/:revisionId/draft')
  @Header('Cache-Control', 'no-store')
  fileRevisionDraft(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string
  ) {
    return ok(this.sessions.fileRevisionDraft(sessionId, revisionId));
  }

  @Put('sessions/:sessionId/file-revisions/:revisionId/draft')
  async saveFileRevisionDraft(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: SaveFileRevisionDraftInput
  ) {
    assertSaveFileRevisionDraftInput(body);
    return ok(await this.sessions.saveFileRevisionDraft(sessionId, revisionId, body));
  }

  @Post('sessions/:sessionId/file-revisions/:revisionId/reprocess')
  async reprocessFileRevision(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: ReprocessFileRevisionInput
  ) {
    assertReprocessFileRevisionInput(body);
    return ok(await this.sessions.reprocessFileRevision(sessionId, revisionId, body));
  }

  @Post('sessions/:sessionId/file-revisions/:revisionId/failure-decision')
  async resolveFileRevisionFailure(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: ResolveFileRevisionFailureInput
  ) {
    assertResolveFileRevisionFailureInput(body);
    return ok(await this.sessions.resolveFileRevisionFailure(sessionId, revisionId, body));
  }

  @Post('sessions/:sessionId/file-revisions/:revisionId/retry')
  async retryInterruptedFileRevision(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: RetryInterruptedFileRevisionInput
  ) {
    assertRetryInterruptedFileRevisionInput(body);
    return ok(await this.sessions.retryInterruptedFileRevision(sessionId, revisionId, body));
  }

  @Post('sessions/:sessionId/file-revisions/:revisionId/decision')
  async decideFileRevision(
    @Param('sessionId') sessionId: string,
    @Param('revisionId') revisionId: string,
    @Body() body: DecideFileRevisionInput
  ) {
    assertDecideFileRevisionInput(body);
    return ok(await this.sessions.decideFileRevision(sessionId, revisionId, body));
  }

  @Delete('sessions/:sessionId')
  async delete(
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') requestId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown }
  ) {
    const result = await this.sessions.delete(sessionId, requestId || crypto.randomUUID());
    response.status(result.deleted ? 200 : 202);
    return ok(result);
  }

  @Post('sessions/:sessionId/restore')
  async restore(
    @Param('sessionId') sessionId: string,
    @Body() body: { requestId: string; expectedGeneration: number }
  ) {
    if (!body?.requestId || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 1) {
      throw new BadRequestException('requestId and a positive expectedGeneration are required.');
    }
    return ok(await this.sessions.restore(sessionId, body));
  }

  @Post('sessions/:sessionId/messages')
  @HttpCode(202)
  sendMessage(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; mentionedAgentIds?: string[]; replyToEventId?: string },
    @Headers('idempotency-key') idempotencyKey?: string
  ) {
    return this.sessions
      .sendMessage(sessionId, body.content, body.mentionedAgentIds, idempotencyKey, body.replyToEventId)
      .then(ok);
  }

  @Post('sessions/:sessionId/memories/confirm')
  confirmMemory(
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string; confirmationId?: string; sourceEventId?: string; confidence?: number }
  ) {
    return ok(this.sessions.confirmMemory(sessionId, body));
  }

  @Post('sessions/:sessionId/pause')
  async pause(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(await this.sessions.pause(sessionId, body?.reason ?? '用户已停止会话', body?.confirmationId));
  }

  @Post('sessions/:sessionId/resume')
  async resume(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(await this.sessions.resume(sessionId, body?.reason ?? '用户已继续会话', body?.confirmationId));
  }

  @Post('sessions/:sessionId/cancel')
  cancel(@Param('sessionId') sessionId: string, @Body() body: { reason?: string; confirmationId?: string }) {
    return ok(this.sessions.control(sessionId, 'CANCELLED', body?.reason ?? '用户已取消会话', body?.confirmationId));
  }

  @Post('sessions/:sessionId/local-runtime/permissions/decision')
  async resolveLocalRuntimePermission(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; decision: 'approve_once' | 'cancel' }
  ) {
    return ok(await this.sessions.resolveLocalRuntimePermission(sessionId, body));
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
  confirmBrief(
    @Param('sessionId') sessionId: string,
    @Param('briefId') briefId: string,
    @Body() body: { confirmationId?: string }
  ) {
    return this.sessions.confirmBrief(sessionId, briefId, body?.confirmationId).then(ok);
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

  @Post('sessions/:sessionId/workflow/agent-substitution')
  async resolveWorkflowAgentSubstitution(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; taskId: string; agentId: string }
  ) {
    if (!body?.confirmationId || !body.taskId || !body.agentId) {
      throw new BadRequestException('confirmationId, taskId and agentId are required.');
    }
    return ok(await this.sessions.resolveWorkflowAgentSubstitution(sessionId, body));
  }

  @Post('sessions/:sessionId/workflow/agent-skip')
  async resolveWorkflowAgentSkip(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; taskId: string; reason?: string }
  ) {
    if (!body?.confirmationId || !body.taskId) {
      throw new BadRequestException('confirmationId and taskId are required.');
    }
    return ok(await this.sessions.resolveWorkflowAgentSkip(sessionId, body));
  }

  @Post('sessions/:sessionId/workflow/upstream-rerun')
  async resolveWorkflowUpstreamRerun(
    @Param('sessionId') sessionId: string,
    @Body() body: {
      confirmationId: string;
      nodeId?: string;
      decision?: 'rerun_upstream' | 'retry_current';
      instruction?: string;
    }
  ) {
    if (!body?.confirmationId) {
      throw new BadRequestException('confirmationId is required.');
    }
    if (body.decision && !['rerun_upstream', 'retry_current'].includes(body.decision)) {
      throw new BadRequestException('decision must be rerun_upstream or retry_current.');
    }
    if (body.decision === 'rerun_upstream' && !body.nodeId) {
      throw new BadRequestException('nodeId is required when rerunning an upstream node.');
    }
    return ok(await this.sessions.resolveWorkflowUpstreamRerun(sessionId, body));
  }

  @Post('sessions/:sessionId/workspace-writebacks/:writebackId/resolve')
  async resolveWorkspaceWriteback(
    @Param('sessionId') sessionId: string,
    @Param('writebackId') writebackId: string,
    @Body() body: ResolveWorkspaceWritebackInput
  ) {
    if (!body || ![
      'retry_merge',
      'resolve_with_agent',
      'keep_workspace',
      'use_session',
      'abandon_writeback'
    ].includes(body.action)) {
      throw new BadRequestException('A valid workspace writeback action is required.');
    }
    return ok(await this.sessions.resolveWorkspaceWriteback(sessionId, writebackId, body));
  }

  @Post('sessions/:sessionId/workflow/member-mapping')
  resolveWorkflowMemberMapping(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; decision: 'approve' | 'decline' }
  ) {
    return this.sessions.resolveWorkflowMemberMapping(sessionId, body).then(ok);
  }

  @Post('sessions/:sessionId/discussions/:discussionId/member-addition')
  resolveMemberAddition(
    @Param('sessionId') sessionId: string,
    @Param('discussionId') discussionId: string,
    @Body() body: { confirmationId: string; decision: 'approve' | 'decline' }
  ) {
    return this.sessions.resolveMemberAddition(sessionId, { ...body, discussionId }).then(ok);
  }

  @Post('sessions/:sessionId/discussions/:discussionId/clarification')
  resolveDiscussionClarification(
    @Param('sessionId') sessionId: string,
    @Param('discussionId') discussionId: string,
    @Body() body: { confirmationId: string; decision: 'answer_in_chat' | 'proceed_anyway' }
  ) {
    return this.sessions.resolveDiscussionClarification(sessionId, { ...body, discussionId }).then(ok);
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
    @Body() body: {
      reason?: string;
      userMessage?: string;
      confirmationId?: string;
      assignedAgentKeys?: string[];
    }
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

function assertCaptureFileRevisionBaselineInput(value: unknown): asserts value is CaptureFileRevisionBaselineInput {
  const body = objectBody(value, ['filePath', 'source']);
  if (typeof body.filePath !== 'string' || !body.filePath.trim()) invalidRevisionBody('filePath is required.');
  if (body.source !== undefined && !['system_output', 'user_selected', 'post_apply'].includes(String(body.source))) {
    invalidRevisionBody('source is invalid.');
  }

}

function assertCreateFileRevisionRunInput(value: unknown): asserts value is CreateFileRevisionRunInput {
  const body = objectBody(value, ['baselineId', 'targetAgentIds', 'instruction']);
  if (typeof body.baselineId !== 'string' || !body.baselineId) invalidRevisionBody('baselineId is required.');
  assertStringArray(body.targetAgentIds, 'targetAgentIds', true);
  if (body.instruction !== undefined && typeof body.instruction !== 'string') invalidRevisionBody('instruction must be a string.');
}

function assertSaveFileRevisionDraftInput(value: unknown): asserts value is SaveFileRevisionDraftInput {
  const body = objectBody(value, ['expectedCandidateHash', 'content']);
  assertFileHash(body.expectedCandidateHash, 'expectedCandidateHash');
  if (typeof body.content !== 'string') invalidRevisionBody('content must be a string.');
}

function assertReprocessFileRevisionInput(value: unknown): asserts value is ReprocessFileRevisionInput {
  const body = objectBody(value, [
    'draftHash',
    'expectedCandidateHash',
    'expectedStateVersion',
    'targetAgentIds',
    'instruction'
  ]);
  assertFileHash(body.draftHash, 'draftHash');
  assertFileHash(body.expectedCandidateHash, 'expectedCandidateHash');
  if (!Number.isInteger(body.expectedStateVersion) || Number(body.expectedStateVersion) < 1) {
    invalidRevisionBody('expectedStateVersion must be a positive integer.');
  }
  if (body.targetAgentIds !== undefined) assertStringArray(body.targetAgentIds, 'targetAgentIds', true);
  if (body.instruction !== undefined && typeof body.instruction !== 'string') invalidRevisionBody('instruction must be a string.');
}

export function assertResolveFileRevisionFailureInput(
  value: unknown
): asserts value is ResolveFileRevisionFailureInput {
  const body = objectBody(value, ['expectedStateVersion', 'decision', 'instruction']);
  if (!Number.isInteger(body.expectedStateVersion) || Number(body.expectedStateVersion) < 1) {
    invalidRevisionBody('expectedStateVersion must be a positive integer.');
  }
  if (!['retry_agents', 'continue_with_successful', 'abandon_revision'].includes(String(body.decision))) {
    throw new BadRequestException('INVALID_FILE_REVISION_DECISION: decision is not allowed.');
  }
  if (body.instruction !== undefined && typeof body.instruction !== 'string') {
    invalidRevisionBody('instruction must be a string.');
  }
}

export function assertRetryInterruptedFileRevisionInput(
  value: unknown
): asserts value is RetryInterruptedFileRevisionInput {
  const body = objectBody(value, ['expectedStateVersion', 'retryKey']);
  if (!Number.isInteger(body.expectedStateVersion) || Number(body.expectedStateVersion) < 1) {
    invalidRevisionBody('expectedStateVersion must be a positive integer.');
  }
  if (typeof body.retryKey !== 'string' || !body.retryKey.trim() || body.retryKey.length > 200) {
    invalidRevisionBody('retryKey must be a non-empty string no longer than 200 characters.');
  }
}

export function assertDecideFileRevisionInput(value: unknown): asserts value is DecideFileRevisionInput {
  const body = objectBody(value, ['confirmationId', 'candidateHash', 'expectedStateVersion', 'decision']);
  if (typeof body.confirmationId !== 'string' || !body.confirmationId) invalidRevisionBody('confirmationId is required.');
  assertFileHash(body.candidateHash, 'candidateHash');
  if (!Number.isInteger(body.expectedStateVersion) || Number(body.expectedStateVersion) < 1) {
    invalidRevisionBody('expectedStateVersion must be a positive integer.');
  }
  if (body.decision !== 'apply_candidate' && body.decision !== 'abandon_revision') {
    throw new BadRequestException('INVALID_FILE_REVISION_DECISION: decision is not allowed.');
  }
}

function objectBody(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRevisionBody('request body must be an object.');
  const body = value as Record<string, unknown>;
  const allowed = new Set(fields);
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  if (unsupported.length) invalidRevisionBody(`unsupported fields: ${unsupported.sort().join(', ')}.`);
  return body;
}

function assertFileHash(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRevisionBody(`${field} must be a SHA-256 hash.`);
  const hash = value as Record<string, unknown>;
  if (hash.algorithm !== 'sha256' || typeof hash.value !== 'string' || !/^[a-f0-9]{64}$/.test(hash.value)) {
    invalidRevisionBody(`${field} must be a SHA-256 hash.`);
  }
  if (Object.keys(hash).some((key) => key !== 'algorithm' && key !== 'value')) invalidRevisionBody(`${field} has unsupported fields.`);
}

function assertStringArray(value: unknown, field: string, nonEmpty: boolean) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    invalidRevisionBody(`${field} must be an array of non-empty strings.`);
  }
  if (nonEmpty && value.length === 0) invalidRevisionBody(`${field} must not be empty.`);
}

function invalidRevisionBody(message: string): never {
  throw new BadRequestException(`INVALID_FILE_REVISION_REQUEST: ${message}`);
}
