import { BadRequestException, ConflictException, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { AgentTask, CollaborationEvent, IntentContextSnapshot, IntentFollowUp, IntentRoutingRecord, SessionDetail, SessionFollowUpMessage, TaskBrief, WorkItem } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { correctionRows as rows, appendCorrectionEvent } from './intent-correction-state.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { currentSourceGrants, inspectSourceFile, inspectSourceRoot, sourceHash } from './intent-source-authority.js';
import { workspaceReadBindingHash } from './intent-workspace-read.js';
import { assertNoPendingInputBudget } from './intent-resume-guard.js';
import { isSourceFollowUp, IntentSourceAuthorizationService, sourceOwner } from './intent-source-authorization.service.js';
import { bindFollowUpUnderstanding, compileFollowUp, FOLLOW_UP_COLLECTIONS, followUpDecisionsHash, followUpQuiescent, liveFollowUpAuthority, saveFollowUpPlan } from './intent-follow-up-state.js';
import type { IntentCommitResult } from './intent-plan-commit.service.js';

@Injectable()
export class IntentFollowUpService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private scanning = false;
  constructor(private readonly persistence: PersistenceService, private readonly authorizations: IntentSourceAuthorizationService,
    @Optional() private readonly briefs?: IntentBriefExecutorService, @Optional() private readonly events?: EventsService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.scan(); }, 2000); this.timer.unref(); void this.scan(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async scan() {
    if (this.scanning) return; this.scanning = true;
    try { for (const session of this.persistence.getCollection<SessionDetail[]>('sessions', [])) {
      const next = session.intentFollowUps?.find(row => row.status === 'queued');
      if (next) {
        try { await this.activate(session.id, next.id, session.ownerId); }
        catch (error) { await this.recordActivationFailure(session.id, next.id, session.ownerId, error); }
      }
    } } finally { this.scanning = false; }
  }

  private async recordActivationFailure(sessionId: string, followId: string, actorId: string, error: unknown) {
    const failureCode = error instanceof ConflictException
      ? (typeof error.getResponse() === 'string' ? error.getResponse() as string : error.message)
      : 'INTENT_FOLLOW_UP_ACTIVATION_FAILED';
    const event = await this.persistence.mutateCollections(FOLLOW_UP_COLLECTIONS, draft => {
      const { session } = sourceOwner(draft, sessionId, actorId);
      const follow = session.intentFollowUps?.find(row => row.id === followId);
      if (!follow || follow.status !== 'queued') return undefined;
      const now = new Date().toISOString();
      follow.status = 'blocked'; follow.failureCode = failureCode; follow.revision++; follow.updatedAt = now;
      const projection = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', sessionId).find(row => row.id === followId);
      if (projection) projection.status = 'failed';
      const blocked: CollaborationEvent = { id: `followup-blocked:${follow.id}:${follow.revision}`, sessionId, workItemId: follow.workItemId,
        type: 'intent_plan_blocked', actor: { type: 'system', id: 'intent-follow-up' }, toAgentIds: [], createdAt: now,
        content: '追加需求未能激活，原请求已保留，请查看失败原因后重新处理。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: follow.routingId, followUpId: follow.id, reasonCode: failureCode, status: 'blocked' } } };
      appendCorrectionEvent(draft, blocked); return blocked;
    }, { sessionIds: [sessionId] });
    if (event) this.events?.acceptCommitted(event);
  }

  async tryCommit(input: { sessionId: string; routingId: string; actorId: string; expectedRoutingRevision: number }): Promise<IntentCommitResult> {
    const route = this.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {})[input.sessionId]?.find(row => row.id === input.routingId);
    const session = this.persistence.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === input.sessionId);
    if (session?.intentContractVersion !== 'intent-understanding-v1' || !isSourceFollowUp(route) || route?.rolloutMode === 'shadow') throw new ConflictException('INTENT_FOLLOW_UP_UNSUPPORTED');
    const possible = session.intentSourceAuthorities?.find(row => row.sourceEventId === route!.sourceEventId && row.workItemId === session.activeWorkItemId && currentSourceGrants(session).some(grant => grant.id === row.grant.id));
    const files = possible ? await Promise.all(possible.files.map(row => inspectSourceFile(possible.rootPath, row.path))) : [];
    if (possible && !isDeepStrictEqual(possible.rootIdentity, await inspectSourceRoot(possible.rootPath))) throw new ConflictException('INTENT_SOURCE_ROOT_STALE');
    const result = await this.persistence.mutateCollections(FOLLOW_UP_COLLECTIONS, draft => {
      const { session, generation } = sourceOwner(draft, input.sessionId, input.actorId);
      assertNoPendingInputBudget(draft, session);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(row => row.id === input.routingId)!;
      const existing = session.intentFollowUps?.find(row => row.routingId === input.routingId);
      if (existing) return { routing: structuredClone(route), plan: structuredClone(route.semanticPlan!), idempotentReplay: true };
      const proposal = route?.semanticProposal, segment = proposal?.understanding?.segments[0];
      const work = rows<WorkItem>(draft, 'workItemsBySession', session.id).find(row => row.id === segment?.target.workItemId);
      const source = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(row => row.id === route?.sourceEventId && row.type === 'user_message' && row.actor?.type === 'user' && row.actor.id === input.actorId);
      const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(row => row.id === proposal?.snapshotId);
      if (!route || !isSourceFollowUp(route) || route.dispatchHold || route.leaseOwner || route.routingRevision !== input.expectedRoutingRevision ||
        !proposal?.understanding || proposal.dataEpoch !== session.dataEpoch || proposal.sessionGeneration !== generation || !source || !snapshot || snapshot.currentMessage !== source.content || snapshot.sourceEventId !== source.id ||
        !work || work.id !== session.activeWorkItemId || work.dispatchHold || ['CANCELLED', 'COMPLETED'].includes(work.status) ||
        rows<WorkItem>(draft, 'workItemsBySession', session.id).filter(row => row.id === work.id).length !== 1) throw new ConflictException('INTENT_FOLLOW_UP_TARGET_STALE');
      if (!['VALIDATING', 'BLOCKED', 'CLARIFICATION_REQUIRED'].includes(route.status) || route.currentIntentRevision) throw new ConflictException('INTENT_FOLLOW_UP_REVISION_CONFLICT');
      if (snapshot.businessFingerprint !== routingBusinessFingerprint(session, rows<WorkItem>(draft, 'workItemsBySession', session.id), rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id))) throw new ConflictException('SNAPSHOT_STALE');
      const authority = possible && liveFollowUpAuthority(session, generation, work.id, possible.id);
      if (!authority || !isDeepStrictEqual(authority, possible)) {
        // No authority is inferred from the proposal; publish a scope request outside this transaction.
        return { needsAuthorization: true as const, revision: route.routingRevision! };
      }
      if (!this.briefs) throw new ConflictException('INTENT_BRIEF_EXECUTOR_UNAVAILABLE');
      const understanding = bindFollowUpUnderstanding(proposal.understanding, session, authority);
      const plan = compileFollowUp(draft, session, route, work, authority, understanding, snapshot, 1, work.requirementRevision ?? 1, generation);
      if (plan.outcome !== 'applicable') throw new ConflictException({ message: 'INTENT_FOLLOW_UP_REVALIDATION_FAILED', reasonCodes: plan.validation.errorCodes });
      if (files.some(file => !authority.files.some(row => row.path === file.path && row.dev === file.dev && row.ino === file.ino))) throw new ConflictException('INTENT_SOURCE_FILE_IDENTITY_STALE');
      const now = new Date().toISOString(), id = `intent-followup:${sourceHash([input.actorId, session.id, session.dataEpoch, generation, source.id, route.id, segment!.localKey])}`;
      const follow: IntentFollowUp = { id, routingId: route.id, sourceEventId: source.id, workItemId: work.id, actorId: input.actorId, dataEpoch: session.dataEpoch!, sessionGeneration: generation,
        sourceAuthorityId: authority.id, understanding: structuredClone(proposal.understanding), compiledUnderstanding: understanding,
        baseline: { requirementRevision: work.requirementRevision ?? 1, executionEpoch: work.executionEpoch ?? 1, decisionSetHash: followUpDecisionsHash(draft, session, work),
          workspaceBindingHash: workspaceReadBindingHash(session)!, files: files.map(row => ({ path: row.path, hash: row.hash.value })) },
        queuedPlan: structuredClone(plan), status: 'queued', revision: 1, createdAt: now, updatedAt: now };
      (session.intentFollowUps ??= []).push(follow);
      saveFollowUpPlan(draft, session, route, follow, plan, understanding, authority, ['queued']);
      const projections = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', session.id);
      for (const previous of projections.filter(row => row.routingId === route.id)) previous.status = 'cancelled';
      projections.push({ id, routingId: route.id, workItemId: work.id, sourceEventId: source.id, content: source.content, status: 'queued', queuedAt: now,
        mentionedAgentIds: [], handlingPlan: { intent: 'clarification', priority: 'normal', shouldPause: false, affectedTaskIds: [], affectedAgentIds: [],
          requiresBriefRevision: true, requiresUserConfirmation: true, coordinatorInstruction: '新链路 step 为唯一派发权威；禁止旧 FollowUp 消费器处理。' } });
      session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(row => row.routingId !== route.id);
      const event: CollaborationEvent = { id: `queued:${id}`, sessionId: session.id, workItemId: work.id, type: 'intent_plan_committed', content: '追加需求已排队，当前任务与版本保持不变；静止后生成新的待确认草稿。', toAgentIds: [], createdAt: now,
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: route.id, followUpId: id, stepId: plan.steps[0].stepId, status: 'queued' } } };
      appendCorrectionEvent(draft, event); return { routing: structuredClone(route), plan: structuredClone(plan), idempotentReplay: false, event };
    }, { sessionIds: [input.sessionId] });
    if ('needsAuthorization' in result) {
      const prior = this.persistence.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === input.sessionId)!.intentSourceAuthorizationRequests?.find(row => row.routingId === input.routingId && row.status === 'pending');
      if (!prior) await this.authorizations.request(input.sessionId, input.actorId, { routingId: input.routingId, expectedRoutingRevision: result.revision,
        idempotencyKey: `scope:${input.routingId}` });
      throw new ConflictException('INTENT_SOURCE_STRUCTURED_AUTHORIZATION_REQUIRED');
    }
    if (result.event) this.events?.acceptCommitted(result.event);
    return result as IntentCommitResult;
  }

  async activate(sessionId: string, followId: string, actorId: string) {
    const saved = this.persistence.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === sessionId);
    const pending = saved?.intentFollowUps?.find(row => row.id === followId);
    const authority = saved?.intentSourceAuthorities?.find(row => row.id === pending?.sourceAuthorityId);
    const files = authority ? await Promise.all(authority.files.map(row => inspectSourceFile(authority.rootPath, row.path))) : [];
    const root = authority ? await inspectSourceRoot(authority.rootPath) : undefined;
    const result = await this.persistence.mutateCollections(FOLLOW_UP_COLLECTIONS, draft => {
      const { session, generation } = sourceOwner(draft, sessionId, actorId);
      const follow = session.intentFollowUps?.find(row => row.id === followId);
      if (!follow) throw new ConflictException('INTENT_FOLLOW_UP_NOT_FOUND');
      if (follow.status !== 'queued') return structuredClone(follow);
      const work = rows<WorkItem>(draft, 'workItemsBySession', sessionId).find(row => row.id === follow.workItemId);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === follow.routingId);
      if (!work || work.id !== session.activeWorkItemId || ['CANCELLED', 'COMPLETED'].includes(work.status) || follow.dataEpoch !== session.dataEpoch || follow.sessionGeneration !== generation) {
        follow.status = 'cancelled'; follow.failureCode = 'INTENT_FOLLOW_UP_TARGET_STALE'; return structuredClone(follow);
      }
      if (session.intentFollowUps!.some(row => row.id !== follow.id && ['brief', 'ready', 'running', 'waiting_budget', 'reconciliation_required'].includes(row.status)) ||
        session.intentFollowUps!.find(row => row.status === 'queued')?.id !== follow.id || !route || route.dispatchHold || work.dispatchHold || !followUpQuiescent(draft, session, follow)) return structuredClone(follow);
      let live;
      try { live = liveFollowUpAuthority(session, generation, work.id, follow.sourceAuthorityId); }
      catch (error) {
        if (error instanceof ConflictException && error.message === 'INTENT_SOURCE_AUTHORITY_STALE') {
          follow.status = 'blocked'; follow.failureCode = 'INTENT_FOLLOW_UP_BASELINE_CHANGED'; return structuredClone(follow);
        }
        throw error;
      }
      if (!isDeepStrictEqual(root, live.rootIdentity) || !isDeepStrictEqual(live, authority) || !isDeepStrictEqual(files.map(row => ({ path: row.path, hash: row.hash.value })), follow.baseline.files) ||
        (work.requirementRevision ?? 1) !== follow.baseline.requirementRevision || (work.executionEpoch ?? 1) !== follow.baseline.executionEpoch ||
        followUpDecisionsHash(draft, session, work) !== follow.baseline.decisionSetHash || workspaceReadBindingHash(session) !== follow.baseline.workspaceBindingHash) {
        follow.status = 'blocked'; follow.failureCode = 'INTENT_FOLLOW_UP_BASELINE_CHANGED'; return structuredClone(follow);
      }
      const snapshot = structuredClone(rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', sessionId).find(row => row.id === route.semanticProposal!.snapshotId)!);
      snapshot.id = `followup-activation:${follow.id}`;
      snapshot.businessFingerprint = routingBusinessFingerprint(session, rows<WorkItem>(draft, 'workItemsBySession', sessionId), rows<CollaborationEvent>(draft, 'eventsBySession', sessionId), rows<AgentTask>(draft, 'tasksBySession', sessionId));
      const plan = compileFollowUp(draft, session, route, work, live, follow.compiledUnderstanding, snapshot, route.currentIntentRevision! + 1, (work.requirementRevision ?? 1) + 1, generation);
      if (plan.outcome !== 'applicable') { follow.status = 'blocked'; follow.failureCode = plan.validation.errorCodes.join(','); return structuredClone(follow); }
      rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', sessionId).push(snapshot);
      const parent = plan.steps[0], emptyBody = { effects: [], prohibitions: [], grantIds: [] };
      const oldBrief = rows<TaskBrief>(draft, 'briefsBySession', sessionId).find(row => row.id === session.currentTaskBriefId);
      if (session.currentTaskBriefId && (!oldBrief?.intentBinding || oldBrief.workItemId !== work.id)) throw new ConflictException('INTENT_FOLLOW_UP_BRIEF_BASELINE_UNPROVEN');
      const briefId = `followup-brief-step:${follow.id}`;
      plan.steps.push({ ...structuredClone(parent), stepId: briefId, action: 'prepare_brief', derivedFromStepId: parent.stepId,
        ...(oldBrief ? { replacesBrief: { briefId: oldBrief.id, version: oldBrief.version } } : {}), segmentKey: `${parent.segmentKey}:brief`,
        effectScope: { ...emptyBody, scopeHash: sourceHash(emptyBody) }, executionBinding: { ...parent.executionBinding, effectScopeHash: sourceHash(emptyBody) }, idempotencyKey: `${parent.idempotencyKey}:brief` });
      rows<any>(draft, 'intentPlanStepsBySession', sessionId).find(row => row.id === follow.queuedPlan.steps[0].stepId).status = 'completed';
      work.requirementRevision = (work.requirementRevision ?? 1) + 1; work.revision++; work.updatedAt = new Date().toISOString();
      Object.assign(follow, { status: 'brief', briefStepId: briefId, revision: follow.revision + 1, updatedAt: work.updatedAt });
      session.status = oldBrief ? 'REVISING_BRIEF' : 'DRAFT_INPUT'; session.revision = (session.revision ?? 1) + 1;
      saveFollowUpPlan(draft, session, route, follow, plan, follow.compiledUnderstanding, live, ['completed', 'queued']);
      const projection = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', sessionId).find(row => row.id === follow.id)!;
      projection.status = 'planning'; projection.startedAt = work.updatedAt;
      return structuredClone(follow);
    }, { sessionIds: [sessionId] });
    if (result.status === 'brief' && result.briefStepId) this.briefs?.schedule({ sessionId, stepId: result.briefStepId });
    return result;
  }

  async cancel(sessionId: string, followId: string, actorId: string, raw: number | { expectedRevision: number; idempotencyKey: string }) {
    const input = typeof raw === 'number' ? { expectedRevision: raw, idempotencyKey: `legacy-cancel:${followId}:${raw}` } : raw;
    if (!input || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new BadRequestException('INTENT_FOLLOW_UP_CANCEL_INPUT_INVALID');
    }
    const payloadHash = sourceHash(input);
    return this.persistence.mutateCollections(FOLLOW_UP_COLLECTIONS, draft => {
      const { session } = sourceOwner(draft, sessionId, actorId), follow = session.intentFollowUps?.find(row => row.id === followId);
      if (!follow) throw new ConflictException('INTENT_FOLLOW_UP_REVISION_CONFLICT');
      const prior = follow.cancelDecisions?.find(row => row.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.actorId !== actorId || prior.expectedRevision !== input.expectedRevision || sourceHash({ expectedRevision: prior.expectedRevision, idempotencyKey: prior.idempotencyKey }) !== payloadHash) {
          throw new ConflictException('INTENT_FOLLOW_UP_CANCEL_IDEMPOTENCY_CONFLICT');
        }
        return structuredClone(prior.result);
      }
      if (follow.revision !== input.expectedRevision || !['queued', 'brief'].includes(follow.status)) throw new ConflictException('INTENT_FOLLOW_UP_REVISION_CONFLICT');
      follow.status = 'cancelled'; follow.revision++;
      for (const step of rows<any>(draft, 'intentPlanStepsBySession', sessionId).filter(row => row.routingId === follow.routingId && ['queued', 'running'].includes(row.status))) step.status = 'invalidated';
      const projection = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', sessionId).find(row => row.id === follow.id); if (projection) projection.status = 'cancelled';
      const result = structuredClone(follow);
      (follow.cancelDecisions ??= []).push({ actorId, idempotencyKey: input.idempotencyKey, expectedRevision: input.expectedRevision, result });
      return result;
    }, { sessionIds: [sessionId] });
  }
}
