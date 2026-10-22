import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, HttpCode, Optional, Param, Post, Put, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import crypto from 'node:crypto';
import type { RuntimeSwitchInput } from '@agent-cluster/shared';
import type { ServerResponse } from 'node:http';
import { ok } from '../../common/api-response.js';
import type {
  CaptureFileRevisionBaselineInput,
  ClarifyIntentRoutingInput,
  CreateFileRevisionRunInput,
  DecideFileRevisionInput,
  ReprocessFileRevisionInput,
  ResolveWorkspaceWritebackInput,
  ResolveFileRevisionFailureInput,
  RetryInterruptedFileRevisionInput,
  SaveFileRevisionDraftInput,
  PostReviewAction,
  RuntimePreference,
  SessionCodeSource,
  SessionExecutionLocation,
  SessionWorkingDirectory,
  CreateDiscussionDocumentInput
} from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';
import { IntentReconciliationService } from '../message-routing/intent-reconciliation.service.js';
import { IntentCorrectionService } from '../message-routing/intent-correction.service.js';
import { IntentWorkspaceAuthorityService } from '../message-routing/intent-workspace-authority.service.js';
import { IntentTestAuthorityService } from '../message-routing/intent-test-authority.service.js';
import { IntentAuthorizationRetryService } from '../message-routing/intent-authorization-retry.service.js';
import { IntentRecognitionRetryService } from '../message-routing/intent-recognition-retry.service.js';
import { IntentBriefRetryService } from '../message-routing/intent-brief-retry.service.js';
import type { GroupChatMessageDirectives } from '@agent-cluster/shared';
import { DiscussionDocumentsService } from '../discussion-documents/discussion-documents.service.js';
import { SourcePreparationCoordinator } from './source-preparation-coordinator.js';
import { GitHubAuthorizationService } from '../code-hosts/github-authorization.service.js';
import { DeliveryCoordinator } from '../delivery/delivery-coordinator.js';
import type { RepositoryValidationCommand } from '@agent-cluster/shared';
import { isRuntimeHealthWaitInput, type RuntimeHealthWaitInput } from '@agent-cluster/shared';
import { IntentSourceAuthorizationService } from '../message-routing/intent-source-authorization.service.js';
import { IntentSourceReconciliationService } from '../message-routing/intent-source-reconciliation.service.js';
import { IntentFollowUpService } from '../message-routing/intent-follow-up.service.js';

@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    @Optional() private readonly discussionDocuments?: DiscussionDocumentsService,
    @Optional() private readonly sourcePreparation?: SourcePreparationCoordinator,
    @Optional() private readonly githubAuthorizations?: GitHubAuthorizationService,
    @Optional() private readonly deliveryCoordinator?: DeliveryCoordinator,
    @Optional() private readonly intentCorrections?: IntentCorrectionService,
    @Optional() private readonly intentWorkspaceAuthority?: IntentWorkspaceAuthorityService,
    @Optional() private readonly intentTestAuthority?: IntentTestAuthorityService,
    @Optional() private readonly intentAuthorizationRetry?: IntentAuthorizationRetryService,
    @Optional() private readonly intentRecognitionRetry?: IntentRecognitionRetryService,
    @Optional() private readonly intentBriefRetry?: IntentBriefRetryService,
    @Optional() private readonly intentReconciliations?: IntentReconciliationService,
    @Optional() private readonly intentSourceAuthorization?: IntentSourceAuthorizationService,
    @Optional() private readonly intentSourceReconciliation?: IntentSourceReconciliationService,
    @Optional() private readonly intentFollowUps?: IntentFollowUpService
  ) {}

  @Get('sessions/:sessionId/intent-reconciliations')
  @Header('Cache-Control', 'no-store')
  async intentReconciliationsList(@Param('sessionId') sessionId: string) {
    if (!this.intentReconciliations) throw new ServiceUnavailableException('INTENT_RECONCILIATION_UNAVAILABLE');
    return ok(await this.intentReconciliations.list(sessionId, this.sessions.get(sessionId).ownerId));
  }

  @Post('sessions/:sessionId/intent-reconciliations/:caseId/decision')
  @HttpCode(202)
  async decideIntentReconciliation(@Param('sessionId') sessionId: string, @Param('caseId') caseId: string, @Body() body: unknown) {
    if (!this.intentReconciliations) throw new ServiceUnavailableException('INTENT_RECONCILIATION_UNAVAILABLE');
    return ok(await this.intentReconciliations.decide(sessionId, caseId, this.sessions.get(sessionId).ownerId, body));
  }

  @Post('sessions/:sessionId/intent-source-authorization')
  @HttpCode(202)
  async requestIntentSourceAuthorization(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    if (!this.intentSourceAuthorization) throw new ServiceUnavailableException('INTENT_SOURCE_AUTHORIZATION_UNAVAILABLE');
    return ok(await this.intentSourceAuthorization.request(sessionId, this.sessions.get(sessionId).ownerId, body));
  }

  @Post('sessions/:sessionId/intent-source-authorization/:requestId/decision')
  @HttpCode(202)
  async decideIntentSourceAuthorization(@Param('sessionId') sessionId: string, @Param('requestId') requestId: string, @Body() body: unknown) {
    if (!this.intentSourceAuthorization) throw new ServiceUnavailableException('INTENT_SOURCE_AUTHORIZATION_UNAVAILABLE');
    return ok(await this.intentSourceAuthorization.decide(sessionId, requestId, this.sessions.get(sessionId).ownerId, body));
  }

  @Get('sessions/:sessionId/intent-source-authorization/:requestId/candidates')
  @Header('Cache-Control', 'no-store')
  async intentSourceAuthorizationCandidates(@Param('sessionId') sessionId: string, @Param('requestId') requestId: string,
    @Query('query') query?: string, @Query('cursor') cursor?: string, @Query('limit') rawLimit?: string) {
    if (!this.intentSourceAuthorization) throw new ServiceUnavailableException('INTENT_SOURCE_AUTHORIZATION_UNAVAILABLE');
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    return ok(await this.intentSourceAuthorization.candidates(sessionId, requestId, this.sessions.get(sessionId).ownerId,
      { ...(query === undefined ? {} : { query }), ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) }));
  }

  @Get('sessions/:sessionId/intent-source-reconciliations')
  @Header('Cache-Control', 'no-store')
  async intentSourceReconciliations(@Param('sessionId') sessionId: string) {
    if (!this.intentSourceReconciliation) throw new ServiceUnavailableException('INTENT_SOURCE_RECONCILIATION_UNAVAILABLE');
    return ok(await this.intentSourceReconciliation.view(sessionId, this.sessions.get(sessionId).ownerId));
  }

  @Post('sessions/:sessionId/intent-source-reconciliations/:claimId/decision')
  @HttpCode(202)
  async decideIntentSourceReconciliation(@Param('sessionId') sessionId: string, @Param('claimId') claimId: string, @Body() body: unknown) {
    if (!this.intentSourceReconciliation) throw new ServiceUnavailableException('INTENT_SOURCE_RECONCILIATION_UNAVAILABLE');
    return ok(await this.intentSourceReconciliation.decide(sessionId, claimId, this.sessions.get(sessionId).ownerId, body));
  }

  @Post('sessions/:sessionId/intent-follow-ups/:followUpId/cancel')
  @HttpCode(202)
  async cancelIntentFollowUp(@Param('sessionId') sessionId: string, @Param('followUpId') followUpId: string, @Body() body: unknown) {
    if (!this.intentFollowUps) throw new ServiceUnavailableException('INTENT_FOLLOW_UP_UNAVAILABLE');
    return ok(await this.intentFollowUps.cancel(sessionId, followUpId, this.sessions.get(sessionId).ownerId, body as { expectedRevision: number; idempotencyKey: string }));
  }

  @Post('sessions/:sessionId/input-budget/decision')
  @HttpCode(202)
  async decideInputBudget(@Param('sessionId') sessionId: string, @Body() body: import('@agent-cluster/shared').DecideInputBudgetInput) {
    return ok(await this.sessions.decideInputBudget(sessionId, body));
  }

  @Post('sessions/:sessionId/intent-plan-steps/:stepId/retry-brief')
  @HttpCode(202)
  async retryIntentBrief(@Param('sessionId') sessionId: string, @Param('stepId') stepId: string, @Body() body: unknown) {
    if (!this.intentBriefRetry) throw new ServiceUnavailableException('INTENT_BRIEF_RETRY_UNAVAILABLE');
    return ok(await this.intentBriefRetry.retry(sessionId, stepId, this.sessions.get(sessionId).ownerId, body));
  }

  @Get('sessions/:sessionId/intent-plan-steps/:stepId/brief-recovery')
  @Header('Cache-Control', 'no-store')
  async intentBriefRecovery(@Param('sessionId') sessionId: string, @Param('stepId') stepId: string) {
    if (!this.intentBriefRetry) throw new ServiceUnavailableException('INTENT_BRIEF_RETRY_UNAVAILABLE');
    return ok(await this.intentBriefRetry.view(sessionId, stepId, this.sessions.get(sessionId).ownerId));
  }

  @Get('sessions/:sessionId/intent-test-authority')
  testAuthority(@Param('sessionId') sessionId: string) {
    if (!this.intentTestAuthority) throw new ServiceUnavailableException('INTENT_AUTHORITY_SERVICE_UNAVAILABLE');
    return ok(this.intentTestAuthority.view(this.sessions.get(sessionId)));
  }

  @Post('sessions/:sessionId/intent-test-authority')
  async changeTestAuthority(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    if (!this.intentTestAuthority) throw new ServiceUnavailableException('INTENT_AUTHORITY_SERVICE_UNAVAILABLE');
    const session = this.sessions.get(sessionId);
    return ok(await this.intentTestAuthority.change(sessionId, session.ownerId, body));
  }

  @Get('sessions/:sessionId/intent-workspace-read-authority')
  workspaceReadAuthority(@Param('sessionId') sessionId: string) {
    if (!this.intentWorkspaceAuthority) throw new ServiceUnavailableException('INTENT_AUTHORITY_SERVICE_UNAVAILABLE');
    return ok(this.intentWorkspaceAuthority.view(this.sessions.get(sessionId)));
  }

  @Post('sessions/:sessionId/intent-workspace-read-authority')
  async changeWorkspaceReadAuthority(@Param('sessionId') sessionId: string, @Body() body: unknown) {
    if (!this.intentWorkspaceAuthority) throw new ServiceUnavailableException('INTENT_AUTHORITY_SERVICE_UNAVAILABLE');
    const session = this.sessions.get(sessionId);
    return ok(await this.intentWorkspaceAuthority.change(sessionId, session.ownerId, body));
  }

  @Get('sessions')
  list(@Query('visibility') visibility?: 'active' | 'deleted' | 'archived' | 'all') {
    if (visibility && !['active', 'deleted', 'archived', 'all'].includes(visibility)) {
      throw new BadRequestException('visibility must be active, deleted, archived or all.');
    }
    return ok({
      items: this.sessions.list(visibility ?? 'active'),
      hasMore: false
    });
  }

  @Get('sessions/archives')
  archives() {
    return ok({ groups: this.sessions.listArchivedGroups() });
  }

  @Get('sessions/:sessionId/runtime-health')
  @Header('Cache-Control', 'no-store')
  runtimeHealth(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.runtimeHealthState(sessionId));
  }

  @Get('sessions/:sessionId/runtime-switch')
  @Header('Cache-Control', 'no-store')
  runtimeSwitch(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.runtimeSwitchState(sessionId));
  }

  @Post('sessions/:sessionId/runtime-switch')
  async switchRuntime(@Param('sessionId') sessionId: string, @Body() body: RuntimeSwitchInput,
    @Headers('idempotency-key') key?: string) {
    return ok(await this.sessions.switchRuntime(sessionId, { ...body, idempotencyKey: key ?? body?.idempotencyKey }));
  }

  @Post('sessions/:sessionId/runtime-health/:invocationId/wait')
  @Header('Cache-Control', 'no-store')
  async waitForRuntime(@Param('sessionId') sessionId: string, @Param('invocationId') invocationId: string,
    @Body() body: RuntimeHealthWaitInput) {
    if (!isRuntimeHealthWaitInput(body)) throw new BadRequestException('Invalid runtime health wait request.');
    return ok(await this.sessions.waitForRuntime(sessionId, invocationId, body));
  }

  @Get('sessions/code-source-capabilities')
  codeSourceCapabilities() {
    return ok({ githubCreateEnabled: process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED === 'true' });
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
      codeSource?: SessionCodeSource;
      executionLocation?: SessionExecutionLocation;
      runtimePreference?: RuntimePreference;
    }
  ) {
    assertSessionCreateContract(body);
    if (process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED === 'true' &&
        (body.executionLocation === 'server' || body.workingDirectory?.kind === 'server_local') &&
        body.codeSource?.kind !== 'remote_repository') {
      throw new BadRequestException('SERVER_SESSION_REQUIRES_GITHUB_SOURCE');
    }
    if (body.codeSource?.kind === 'remote_repository' &&
        process.env.AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('GITHUB_SESSION_CREATE_NOT_ENABLED');
    }
    return this.sessions.create(body).then((result) => {
      if (result.session.sourceBinding) {
        void this.requireSourcePreparation().prepare(result.session.id).catch(() => undefined);
      }
      return ok(result);
    });
  }

  @Post('code-hosts/github/oauth/start')
  @Header('Cache-Control', 'no-store')
  async startGitHubOAuth(@Body() body: { sessionId?: string }) {
    if (!body?.sessionId) throw new BadRequestException('sessionId is required.');
    return ok(await this.requireSourcePreparation().startOAuth(body.sessionId));
  }

  @Get('code-hosts/github/oauth/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async finishGitHubOAuth(@Query('code') code?: string, @Query('state') state?: string) {
    if (!code || !state) throw new BadRequestException('GitHub OAuth code and state are required.');
    await this.requireSourcePreparation().completeOAuth(code, state);
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GitHub 授权完成</title><body><p>GitHub 授权已完成。请返回原会话继续操作。</p></body></html>';
  }

  @Post('code-hosts/github/tokens')
  @Header('Cache-Control', 'no-store')
  async saveGitHubPat(@Body() body: { sessionId?: string; token?: string }) {
    if (!body?.sessionId || !body.token) throw new BadRequestException('sessionId and token are required.');
    return ok(await this.requireSourcePreparation().savePat(body.sessionId, body.token));
  }

  @Delete('code-hosts/github/authorizations/:id')
  async disconnectGitHubAuthorization(@Param('id') authorizationId: string,
    @Query('deviceId') deviceId?: string, @Query('repositoryUrl') repositoryUrl?: string) {
    if (deviceId || repositoryUrl) {
      if (!deviceId || !repositoryUrl) {
        throw new BadRequestException('deviceId and repositoryUrl are required together.');
      }
      return ok(await this.requireSourcePreparation().disconnectLocalAuthorization(
        authorizationId, deviceId, repositoryUrl));
    }
    if (!this.githubAuthorizations) throw new ServiceUnavailableException('GitHub authorization service is unavailable.');
    return ok(await this.githubAuthorizations.disconnect(authorizationId));
  }

  @Get('sessions/:sessionId/source/branches')
  async sourceBranches(@Param('sessionId') sessionId: string) {
    return ok(await this.requireSourcePreparation().branches(sessionId));
  }

  @Post('sessions/:sessionId/source/base-branch')
  async selectSourceBaseBranch(@Param('sessionId') sessionId: string,
    @Body() body: { branch?: string; expectedSourceVersion?: number }) {
    if (!body?.branch || !Number.isSafeInteger(body.expectedSourceVersion)) {
      throw new BadRequestException('branch and expectedSourceVersion are required.');
    }
    return ok(await this.requireSourcePreparation().selectBranch(sessionId,
      body.branch, body.expectedSourceVersion!));
  }

  @Post('sessions/:sessionId/source/retry')
  async retrySourcePreparation(@Param('sessionId') sessionId: string) {
    return ok(await this.requireSourcePreparation().prepare(sessionId));
  }

  @Get('sessions/:sessionId/delivery')
  delivery(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.get(sessionId).delivery ?? null);
  }

  @Get('sessions/:sessionId/delivery/diff')
  async deliveryDiff(@Param('sessionId') sessionId: string,
    @Query('kind') kind?: string, @Query('page') rawPage?: string) {
    const page = rawPage ? Number(rawPage) : 1;
    if (!['pull_request', 'merged_commit'].includes(kind ?? '') ||
        !Number.isSafeInteger(page) || page < 1 || page > 30) {
      throw new BadRequestException('kind and page are invalid.');
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.diff(sessionId,
      kind as 'pull_request' | 'merged_commit', page));
  }

  @Post('sessions/:sessionId/delivery/validate')
  async validateDelivery(@Param('sessionId') sessionId: string,
    @Body() body: { expectedDeliveryVersion?: number; command?: RepositoryValidationCommand }) {
    if (!Number.isSafeInteger(body?.expectedDeliveryVersion)) {
      throw new BadRequestException('expectedDeliveryVersion is required.');
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.validate(sessionId,
      body.expectedDeliveryVersion!, body.command));
  }

  @Post('sessions/:sessionId/delivery/publish')
  async publishDelivery(@Param('sessionId') sessionId: string,
    @Body() body: { expectedDeliveryVersion?: number }) {
    if (!Number.isSafeInteger(body?.expectedDeliveryVersion)) {
      throw new BadRequestException('expectedDeliveryVersion is required.');
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.publish(sessionId, body.expectedDeliveryVersion!));
  }

  @Post('sessions/:sessionId/delivery/refresh')
  async refreshDelivery(@Param('sessionId') sessionId: string,
    @Body() body: { expectedDeliveryVersion?: number }) {
    if (!Number.isSafeInteger(body?.expectedDeliveryVersion)) {
      throw new BadRequestException('expectedDeliveryVersion is required.');
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.refresh(sessionId, body.expectedDeliveryVersion!));
  }

  @Post('sessions/:sessionId/delivery/merge')
  async mergeDelivery(@Param('sessionId') sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { expectedDeliveryVersion?: number; expectedHeadSha?: string }) {
    if (!Number.isSafeInteger(body?.expectedDeliveryVersion) ||
        !/^[a-f0-9]{40}$/i.test(body?.expectedHeadSha ?? '') ||
        !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey ?? '')) {
      throw new BadRequestException('expectedDeliveryVersion, expectedHeadSha and Idempotency-Key are required.');
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.merge(sessionId, body.expectedDeliveryVersion!,
      body.expectedHeadSha!, idempotencyKey!));
  }

  @Get('sessions/:sessionId/conflicts/:conflictId')
  async githubConflict(@Param('sessionId') sessionId: string,
    @Param('conflictId') conflictId: string) {
    if (this.sessions.hasWorkspaceWritebackConflict(sessionId, conflictId)) {
      return ok(this.sessions.workspaceWritebackConflictView(sessionId, conflictId));
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.conflictView(sessionId, conflictId));
  }

  @Put('sessions/:sessionId/conflicts/:conflictId/files/:fileId')
  async saveGitHubConflictFile(@Param('sessionId') sessionId: string,
    @Param('conflictId') conflictId: string, @Param('fileId') fileId: string,
    @Body() body: { expectedConflictVersion?: number; resultContent?: string;
      binaryChoice?: 'ours' | 'theirs'; confirm?: boolean }) {
    if (!Number.isSafeInteger(body?.expectedConflictVersion) ||
        typeof body.confirm !== 'boolean') {
      throw new BadRequestException('expectedConflictVersion and confirm are required.');
    }
    if (this.sessions.hasWorkspaceWritebackConflict(sessionId, conflictId)) {
      return ok(await this.sessions.saveWorkspaceWritebackConflictFile(sessionId, conflictId, fileId, {
        expectedVersion: body.expectedConflictVersion!, resultContent: body.resultContent,
        binaryChoice: body.binaryChoice, confirm: body.confirm
      }));
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.saveConflictFile(sessionId, conflictId, fileId, {
      expectedVersion: body.expectedConflictVersion!, resultContent: body.resultContent,
      binaryChoice: body.binaryChoice, confirm: body.confirm
    }));
  }

  @Post('sessions/:sessionId/conflicts/:conflictId/complete')
  async completeGitHubConflict(@Param('sessionId') sessionId: string,
    @Param('conflictId') conflictId: string,
    @Body() body: { expectedConflictVersion?: number }) {
    if (!Number.isSafeInteger(body?.expectedConflictVersion)) {
      throw new BadRequestException('expectedConflictVersion is required.');
    }
    if (this.sessions.hasWorkspaceWritebackConflict(sessionId, conflictId)) {
      return ok(await this.sessions.resolveWorkspaceWriteback(sessionId, conflictId, {
        action: 'apply_conflict', expectedConflictVersion: body.expectedConflictVersion
      }));
    }
    if (!this.deliveryCoordinator) throw new ServiceUnavailableException('GITHUB_DELIVERY_UNAVAILABLE');
    return ok(await this.deliveryCoordinator.completeConflict(sessionId, conflictId,
      body.expectedConflictVersion!));
  }

  private requireSourcePreparation(): SourcePreparationCoordinator {
    if (!this.sourcePreparation) throw new ServiceUnavailableException('Source preparation service is unavailable.');
    return this.sourcePreparation;
  }

  @Get('sessions/:sessionId')
  detail(@Param('sessionId') sessionId: string) {
    return ok(this.sessions.getIncludingDeleted(sessionId));
  }

  @Get('sessions/:sessionId/messages/:eventId/historical-context')
  historicalMessageContext(
    @Param('sessionId') sessionId: string,
    @Param('eventId') eventId: string
  ) {
    return ok(this.sessions.getHistoricalMessageContext(sessionId, eventId));
  }

  @Post('sessions/:sessionId/discussion-documents')
  async createDiscussionDocument(
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Omit<CreateDiscussionDocumentInput, 'clientMessageId'> & { clientMessageId?: string }
  ) {
    const session = this.sessions.get(sessionId);
    return ok(await this.requireDiscussionDocuments().create(session, {
      ...body,
      clientMessageId: body.clientMessageId?.trim() || idempotencyKey?.trim() || ''
    }));
  }

  @Get('sessions/:sessionId/discussion-documents')
  listDiscussionDocuments(@Param('sessionId') sessionId: string) {
    this.sessions.getIncludingDeleted(sessionId);
    return ok({ items: this.requireDiscussionDocuments().list(sessionId), hasMore: false });
  }

  @Get('sessions/:sessionId/discussion-documents/active')
  @Header('Cache-Control', 'no-store')
  activeDiscussionDocument(@Param('sessionId') sessionId: string) {
    this.sessions.getIncludingDeleted(sessionId);
    return ok(this.requireDiscussionDocuments().active(sessionId) ?? null);
  }

  @Get('sessions/:sessionId/discussion-documents/:documentId')
  @Header('Cache-Control', 'no-store')
  discussionDocument(
    @Param('sessionId') sessionId: string,
    @Param('documentId') documentId: string
  ) {
    this.sessions.getIncludingDeleted(sessionId);
    return ok(this.requireDiscussionDocuments().get(sessionId, documentId));
  }

  @Get('sessions/:sessionId/discussion-documents/:documentId/content')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  discussionDocumentContent(
    @Param('sessionId') sessionId: string,
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) response: ServerResponse
  ) {
    this.sessions.getIncludingDeleted(sessionId);
    const result = this.requireDiscussionDocuments().content(sessionId, documentId);
    response.setHeader('ETag', `"sha256-${result.contentHash}"`);
    return result.content;
  }

  private requireDiscussionDocuments() {
    if (!this.discussionDocuments) throw new ServiceUnavailableException('Discussion document service is unavailable.');
    return this.discussionDocuments;
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

  @Get('sessions/:sessionId/message-routings')
  @Header('Cache-Control', 'no-store')
  messageRoutings(@Param('sessionId') sessionId: string, @Query('sourceEventId') sourceEventId: string) {
    return ok({ items: this.sessions.listIntentRoutingsForMessage(sessionId, sourceEventId), hasMore: false });
  }

  @Get('sessions/:sessionId/message-routings/:routingId')
  @Header('Cache-Control', 'no-store')
  messageRouting(
    @Param('sessionId') sessionId: string,
    @Param('routingId') routingId: string
  ) {
    return ok(this.sessions.getIntentRouting(sessionId, routingId));
  }

  @Post('sessions/:sessionId/message-routings/:routingId/clarify')
  @HttpCode(200)
  async clarifyMessageRouting(
    @Param('sessionId') sessionId: string,
    @Param('routingId') routingId: string,
    @Body() body: ClarifyIntentRoutingInput
  ) {
    return ok(await this.sessions.clarifyIntentRouting(sessionId, routingId, body));
  }

  @Post('sessions/:sessionId/message-routings/:routingId/retry-authorization')
  @HttpCode(200)
  async retryIntentAuthorization(@Param('sessionId') sessionId: string, @Param('routingId') routingId: string, @Body() body: unknown) {
    if (!this.intentAuthorizationRetry) throw new ServiceUnavailableException('INTENT_AUTHORIZATION_RETRY_UNAVAILABLE');
    return ok(await this.intentAuthorizationRetry.retry(sessionId, routingId, this.sessions.get(sessionId).ownerId, body));
  }

  @Post('sessions/:sessionId/message-routings/:routingId/retry-recognition')
  @HttpCode(202)
  async retryIntentRecognition(@Param('sessionId') sessionId: string, @Param('routingId') routingId: string, @Body() body: unknown) {
    if (!this.intentRecognitionRetry) throw new ServiceUnavailableException('INTENT_RECOGNITION_RETRY_UNAVAILABLE');
    return ok(await this.intentRecognitionRetry.retry(sessionId, routingId, this.sessions.get(sessionId).ownerId, body));
  }

  @Post('sessions/:sessionId/message-routings/:routingId/corrections')
  @HttpCode(202)
  async correctMessageRouting(@Param('sessionId') sessionId: string, @Param('routingId') routingId: string, @Body() body: unknown) {
    const session = this.sessions.get(sessionId);
    if (!this.intentCorrections) throw new ServiceUnavailableException('INTENT_CORRECTION_UNAVAILABLE');
    const result = await this.intentCorrections.accept(sessionId, routingId, session.ownerId, body);
    if (['accepted', 'waiting_for_stop', 'validating', 'reconciliation_required'].includes(result.correction.status)) this.intentCorrections.schedule(result.correction);
    const correction = result.correction;
    return ok({ correctionId: correction.id, routingId, pendingIntentRevision: correction.pendingIntentRevision,
      routingRevision: correction.routingRevision, correctionStatus: correction.status,
      affectedExecutionIds: correction.affectedExecutionIds, idempotentReplay: result.idempotentReplay });
  }

  @Get('sessions/:sessionId/message-routings/:routingId/corrections')
  @Header('Cache-Control', 'no-store')
  correctionHistory(@Param('sessionId') sessionId: string, @Param('routingId') routingId: string) {
    this.sessions.getIntentRouting(sessionId, routingId);
    if (!this.intentCorrections) throw new ServiceUnavailableException('INTENT_CORRECTION_UNAVAILABLE');
    return ok({ corrections: this.intentCorrections.list(sessionId, routingId), revisions: this.intentCorrections.history(sessionId, routingId) });
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

  @Post('sessions/:sessionId/archive')
  async archive(
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') requestId?: string
  ) {
    return ok(await this.sessions.archive(sessionId, requestId || crypto.randomUUID()));
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

  @Post('sessions/:sessionId/archive/restore')
  async restoreArchive(
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') requestId?: string
  ) {
    return ok(await this.sessions.restoreArchived(sessionId, requestId || crypto.randomUUID()));
  }

  @Post('sessions/:sessionId/messages')
  @HttpCode(202)
  sendMessage(
    @Param('sessionId') sessionId: string,
    @Body() body: {
      content: string;
      mentionedAgentIds?: string[];
      replyToEventId?: string;
      attachmentIds?: string[];
      directives?: GroupChatMessageDirectives;
    },
    @Headers('idempotency-key') idempotencyKey?: string
  ) {
    return this.sessions
      .sendMessage(sessionId, body.content, body.mentionedAgentIds, idempotencyKey, body.replyToEventId, body.attachmentIds, body.directives)
      .then(ok);
  }

  @Delete('sessions/:sessionId/messages/:eventId')
  async deleteMessage(
    @Param('sessionId') sessionId: string,
    @Param('eventId') eventId: string
  ) {
    return ok(await this.sessions.deleteMessage(sessionId, eventId));
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

  @Post('sessions/:sessionId/collaboration/cancel')
  async cancelCollaboration(
    @Param('sessionId') sessionId: string,
    @Body() body: { taskId?: string; reason?: string }
  ) {
    return ok(await this.sessions.cancelCollaboration(sessionId, body?.taskId, body?.reason));
  }

  @Post('sessions/:sessionId/collaboration/retry-agent')
  retryCollaborationAgent(
    @Param('sessionId') sessionId: string,
    @Body() body: { agentId: string; taskId?: string }
  ) {
    if (!body?.agentId) throw new BadRequestException('agentId is required.');
    return ok(this.sessions.retryCollaborationAgent(sessionId, body.agentId, body.taskId));
  }

  @Post('sessions/:sessionId/collaboration/re-summarize')
  resummarizeCollaboration(
    @Param('sessionId') sessionId: string,
    @Body() body: { taskId?: string }
  ) {
    return ok(this.sessions.resummarizeCollaboration(sessionId, body?.taskId));
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
    @Body() body: { confirmationId?: string; allowOpenQuestions?: boolean; contractVersion?: string }
  ) {
    if (body?.contractVersion !== undefined) return this.sessions.confirmIntentBrief(sessionId, briefId, body).then(ok);
    return this.sessions.confirmBrief(sessionId, briefId, body?.confirmationId, {
      allowOpenQuestions: body?.allowOpenQuestions === true
    }).then(ok);
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
      'apply_conflict',
      'abandon_writeback'
    ].includes(body.action)) {
      throw new BadRequestException('A valid workspace writeback action is required.');
    }
    return ok(await this.sessions.resolveWorkspaceWriteback(sessionId, writebackId, body));
  }

  @Post('sessions/:sessionId/change-requests/decision')
  resolveExecutionScopeChange(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; choice: 'pause_and_revise' | 'defer' | 'reject' }
  ) {
    return this.sessions.resolveExecutionScopeChange(sessionId, body).then(ok);
  }

  @Post('sessions/:sessionId/workflow/member-mapping')
  resolveWorkflowMemberMapping(
    @Param('sessionId') sessionId: string,
    @Body() body: { confirmationId: string; decision: 'approve' | 'decline' }
  ) {
    if (!body?.confirmationId || !['approve', 'decline'].includes(body.decision)) {
      throw new BadRequestException('confirmationId and a valid mapping decision are required.');
    }
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

  @Post('sessions/:sessionId/agents/:agentId/join')
  joinAgent(@Param('sessionId') sessionId: string, @Param('agentId') agentId: string) {
    return this.sessions.joinAgent(sessionId, agentId).then(ok);
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
      contractVersion?: string;
      reason?: string;
      userMessage?: string;
        confirmationId?: string;
        assignedAgentKeys?: string[];
        questionAnswers?: Array<{ question: string; answer: string }>;
    }
  ) {
    if (body.contractVersion !== undefined) return this.sessions.reviseIntentBrief(sessionId, briefId, body).then(ok);
    return this.sessions.reviseBrief(sessionId, briefId, body).then(ok);
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
  'codeSource',
  'executionLocation',
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
