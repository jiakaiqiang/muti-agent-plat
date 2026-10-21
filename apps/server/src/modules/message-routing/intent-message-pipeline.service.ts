import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException, Injectable, Optional, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { canRetryIntentRecognition, COLLABORATION_CONTRACT_VERSION, type CollaborationEvent, type GroupChatAgentRef, type GroupChatSkillRef, type GroupChatAttachmentRef, type IntentRoutingRecord,
  type IntentRoutingRolloutMode, type ReviseIntentBriefInput, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { EventsService } from '../events/events.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { IntentCorrectionService } from './intent-correction.service.js';
import { issueWorkspaceReadAuthority } from './intent-workspace-read.js';
import { appendCorrectionEvent as appendEvent, correctionRows as rows } from './intent-correction-state.js';
import { bindBriefRevision, briefRevisionCollections } from './intent-brief-revision.js';
import { AgentsService } from '../agents/agents.service.js';

type Reference = { sessionId: string; routingId: string; recognitionOperationId?: string };
const collections = ['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession', 'eventsBySession', 'eventOutbox', ...briefRevisionCollections];
@Injectable()
export class IntentMessagePipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly running = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly controllers = new Set<AbortController>();
  private destroyed = false;
  constructor(private readonly persistence: PersistenceService, private readonly context: ContextManagementService,
    private readonly classifier: IntentUnderstandingRoutingService, private readonly plans: IntentPlanCommitService,
    @Optional() private readonly events?: EventsService, @Optional() private readonly corrections?: IntentCorrectionService,
    @Optional() private readonly agents?: AgentsService) {}

  async accept(input: { session: SessionDetail; first?: boolean; content: string; idempotencyKey: string;
    briefRevision?: { briefId: string; request: ReviseIntentBriefInput };
    skillRef?: GroupChatSkillRef; agentRefs?: GroupChatAgentRef[];
    mentionedAgentIds?: string[]; replyToEventId?: string; attachmentRefs?: GroupChatAttachmentRef[]; rolloutMode: IntentRoutingRolloutMode }) {
    const result = await this.persistence.mutateCollections(collections, draft => {
      const sessions = (draft.sessions ??= []) as SessionDetail[];
      let session = sessions.find(row => row.id === input.session.id);
      const lifecycles = (draft.sessionLifecyclesBySession ??= {}) as SessionLifecyclesBySession;
      if (!session && input.first) {
        if (input.session.intentContractVersion !== 'intent-understanding-v1' || lifecycles[input.session.id]) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
        session = structuredClone(input.session); sessions.push(session);
        lifecycles[session.id] = { contractVersion: COLLABORATION_CONTRACT_VERSION, sessionId: session.id, dataEpoch: session.dataEpoch!,
          generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle' };
      }
      const lifecycle = session && lifecycles[session.id];
      if (!session || session.ownerId !== input.session.ownerId || session.dataEpoch !== input.session.dataEpoch ||
        session.intentContractVersion !== 'intent-understanding-v1' || session.archivedAt || session.status === 'CANCELLED' ||
        !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      const events = rows<CollaborationEvent>(draft, 'eventsBySession', session.id);
      if (input.replyToEventId && !events.some(row => row.id === input.replyToEventId)) throw new ConflictException('REPLY_TARGET_NOT_IN_SESSION');
      const payload = { text: input.content, mentionedAgentIds: [...new Set(input.mentionedAgentIds ?? [])].sort(),
        attachmentRefs: structuredClone(input.attachmentRefs ?? []), replyToEventId: input.replyToEventId ?? null,
        skillRef: input.skillRef ? structuredClone(input.skillRef) : null, agentRefs: structuredClone(input.agentRefs ?? []),
        intentRoutingPending: true, intentContractVersion: 'intent-understanding-v1',
        ...(input.briefRevision ? { briefRevision: structuredClone(input.briefRevision) } : {}) };
      const routings = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id);
      const previous = events.find(row => row.type === 'user_message' && row.metadata.idempotencyKey === input.idempotencyKey);
      if (previous) {
        const routing = routings.find(row => row.sourceEventId === previous.id && row.semanticContractVersion === 'intent-understanding-v1');
        if (!routing || !isDeepStrictEqual(previous.metadata.payload, payload)) throw new ConflictException('INTENT_MESSAGE_IDEMPOTENCY_CONFLICT');
        return { session: structuredClone(session), event: structuredClone(previous), routing: structuredClone(routing), idempotentReplay: true };
      }
      const now = new Date().toISOString();
      const briefRevision = input.briefRevision ? bindBriefRevision(draft, session, input.briefRevision.briefId, input.briefRevision.request) : undefined;
      if (briefRevision?.request.assignedAgentKeys?.length) {
        const ids = briefRevision.request.assignedAgentKeys.map(key => {
          const agent = this.agents?.getForSurface(key, 'chat');
          if (!agent || !session.participatingAgentIds.includes(agent.id)) throw new ConflictException('INTENT_BRIEF_REVIEW_TARGET_UNAVAILABLE');
          return agent.id;
        });
        if (new Set(ids).size !== ids.length) throw new ConflictException('INTENT_BRIEF_REVIEW_TARGETS_DUPLICATED');
        briefRevision.reviewerIds = ids;
      }
      const event: CollaborationEvent = { id: randomUUID(), sessionId: session.id, type: 'user_message', content: input.content,
        toAgentIds: payload.mentionedAgentIds, actor: { type: 'user', id: session.ownerId }, createdAt: now,
        metadata: { schemaVersion: '0.1', renderAs: 'chat_message', idempotencyKey: input.idempotencyKey, payload } };
      if (input.first && !session.intentWorkspaceReadAuthority) {
        session.intentWorkspaceReadAuthority = issueWorkspaceReadAuthority(session, event.id);
      }
      const routing: IntentRoutingRecord = { id: randomUUID(), sessionId: session.id, sourceEventId: event.id,
        ...(briefRevision ? { briefRevision } : {}),
        semanticContractVersion: 'intent-understanding-v1', sessionSeq: Math.max(0, ...routings.map(row => row.sessionSeq)) + 1,
        semanticIngress: { dataEpoch: session.dataEpoch!, sessionGeneration: lifecycle.generation, entryPoint: input.first ? 'first_message' : 'message' },
        routingRevision: 1, status: 'RECEIVED', policyVersion: 'intent-policy-v1', rolloutMode: input.rolloutMode,
        reasonCodes: [], retryCount: 0, idempotencyKey: `${session.id}:${event.id}:intent-understanding-v1`, createdAt: now, updatedAt: now };
      routings.push(routing); appendEvent(draft, event);
      if (briefRevision) {
        session.pendingBriefRevisionRoutingId = routing.id;
        if (session.status === 'PAUSED') session.pauseState!.previousStatus = 'REVISING_BRIEF'; else session.status = 'REVISING_BRIEF';
      }
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      return { session: structuredClone(session), event, routing, idempotentReplay: false };
    }, { sessionIds: [input.session.id] });
    this.events?.acceptCommitted(result.event);
    this.schedule({ sessionId: result.session.id, routingId: result.routing.id });
    return result;
  }

  onModuleInit() {
    for (const records of Object.values(this.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {}))) {
      for (const route of records) if (route.semanticContractVersion && !terminal(route)) this.schedule({ sessionId: route.sessionId, routingId: route.id });
    }
  }

  /** Source checkout is already verified by the source coordinator; publish its binding atomically. */
  async sourceReady(prepared: SessionDetail, expectedSourceVersion: number) {
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === prepared.id);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[prepared.id];
      if (!session || session.dataEpoch !== prepared.dataEpoch || session.intentContractVersion !== 'intent-understanding-v1' ||
        session.archivedAt || session.status === 'CANCELLED' || !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch ||
        session.sourceBinding?.version !== expectedSourceVersion || session.sourceBinding.state !== 'awaiting_base_branch' ||
        prepared.sourceBinding?.state !== 'ready' || prepared.sourceBinding.version !== expectedSourceVersion + 1 ||
        !prepared.workingDirectory || prepared.workingDirectory.id !== session.sourceBinding.workspaceId) throw new ConflictException('SOURCE_PREPARATION_VERSION_CONFLICT');
      session.sourceBinding = structuredClone(prepared.sourceBinding);
      session.workingDirectory = structuredClone(prepared.workingDirectory);
      session.workspaceContext = structuredClone(prepared.workspaceContext);
      session.workspaceId = prepared.workingDirectory.id;
      const now = new Date().toISOString(), eventId = randomUUID();
      // A previously revoked authority must never be silently restored by a source callback.
      if (!session.intentWorkspaceReadAuthority) session.intentWorkspaceReadAuthority = issueWorkspaceReadAuthority(session, eventId);
      if (session.status === 'WAIT_SOURCE_PREPARATION') session.status = 'AGENT_DISCUSSING';
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      const event: CollaborationEvent = { id: eventId, sessionId: session.id, type: 'session_status_changed', createdAt: now,
        content: '源码工作区已准备完成。', toAgentIds: [], actor: { type: 'system', id: 'source-preparation' },
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { status: session.status,
          sourceReady: true, sourceVersion: session.sourceBinding.version, workspaceId: session.workspaceId,
          workspaceReadGrantRevision: session.intentWorkspaceReadAuthority?.grant.revision } } };
      appendEvent(draft, event);
      const pending = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id)
        .filter(route => route.semanticContractVersion && !terminal(route)).map(route => ({ sessionId: session.id, routingId: route.id }));
      return { session: structuredClone(session), event, pending };
    }, { sessionIds: [prepared.id] });
    this.events?.acceptCommitted(result.event);
    for (const reference of result.pending) this.schedule(reference);
    return result.session;
  }
  onModuleDestroy() { this.destroyed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for (const controller of this.controllers) controller.abort(); }
  schedule(reference: Reference, at = Date.now()) {
    reference = this.boundReference(reference);
    const key = `${reference.routingId}:${reference.recognitionOperationId}`;
    if (this.destroyed || this.timers.has(key)) return;
    const timer = setTimeout(() => { this.timers.delete(key); void this.process(reference).catch(() => {
      if (!this.destroyed) this.schedule(reference, Date.now() + 30_000);
    }); }, Math.max(1, Math.min(2_147_483_647, at - Date.now() + 1)));
    timer.unref(); this.timers.set(key, timer);
  }
  process(reference: Reference) {
    reference = this.boundReference(reference);
    const key = `${reference.routingId}:${reference.recognitionOperationId}`;
    const existing = this.running.get(key); if (existing) return existing;
    const run = this.run(reference).finally(() => this.running.delete(key));
    this.running.set(key, run); return run;
  }
  private boundReference(reference: Reference): Reference {
    const route = this.persistence.getCollection<Record<string, IntentRoutingRecord[]>>('intentRoutingRecordsBySession', {})[reference.sessionId]?.find(row => row.id === reference.routingId);
    return { ...reference, recognitionOperationId: reference.recognitionOperationId ?? route?.recognitionOperationId ?? reference.routingId };
  }
  private async run(reference: Reference) {
    if (this.destroyed) return;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      for (;;) {
        const bound = await this.mutate(reference, (draft, session, route) => {
          const event = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(row => row.id === route.sourceEventId && row.type === 'user_message');
          return event && !terminal(route) ? { session: structuredClone(session), route: structuredClone(route), event: structuredClone(event) } : undefined;
        });
        if (!bound || controller.signal.aborted) return;
        // Do not spend classification budget before a selected repository has become readable.
        if (bound.session.sourceBinding && bound.session.sourceBinding.state !== 'ready') return;
        let snapshotId = bound.route.snapshotId;
        const rebuild = bound.route.reasonCodes.includes('SNAPSHOT_STALE');
        if (!snapshotId || rebuild) {
          if (rebuild && !await this.context.reserveRoutingRebuild(reference.sessionId, reference.routingId, reference.recognitionOperationId)) {
            // Another worker may have reserved the sole rebuild but not published its snapshot yet.
            if ((bound.route.classificationAttempts ?? 0) < 2 && Date.parse(bound.route.classificationDeadlineAt ?? '') > Date.now()) {
              this.schedule(reference, Date.now() + 1000); return;
            }
            await this.block(reference, 'INTENT_SNAPSHOT_REBUILD_EXHAUSTED'); return;
          }
          const snapshot = await this.context.buildIntentSnapshot({ session: bound.session, sourceEventId: bound.event.id,
            currentMessage: bound.event.content, latestEventSeq: this.context.listRoutingRecords(bound.session.id).length,
            mentionedAgentIds: bound.event.toAgentIds, attachmentRefs: bound.event.metadata.payload?.attachmentRefs as GroupChatAttachmentRef[] | undefined,
            skillRef: (bound.event.metadata.payload?.skillRef as GroupChatSkillRef | null) ?? undefined,
            agentRefs: bound.event.metadata.payload?.agentRefs as GroupChatAgentRef[] | undefined,
            replyToEventId: (bound.event.metadata.payload?.replyToEventId as string | null) ?? undefined });
          snapshotId = await this.mutate(reference, (_draft, _session, route) => {
            if (terminal(route) || route.leaseOwner) return route.snapshotId;
            if (!route.snapshotId || (rebuild && route.snapshotId === bound.route.snapshotId)) {
              route.snapshotId = snapshot.id; route.status = 'SNAPSHOT_READY'; route.reasonCodes = [];
              route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = new Date().toISOString();
            }
            return route.snapshotId;
          });
        }
        if (!snapshotId || controller.signal.aborted) return;
        const proposal = await this.classifier.classify({ ...reference, snapshotId }, controller.signal);
        if (controller.signal.aborted) return;
        if (proposal.status === 'VALIDATING' && proposal.semanticProposal?.understanding) {
          try {
            if (proposal.semanticProposal.understanding.segments.some(segment => segment.dialogueAct === 'correction' || segment.suggestedAction === 'correct_route')) {
              if (!this.corrections) throw new ConflictException('INTENT_CORRECTION_SERVICE_UNAVAILABLE');
              try {
                const accepted = await this.corrections.acceptMessage(reference.sessionId, bound.session.ownerId, reference.routingId);
                this.corrections.schedule(accepted.correction);
              } catch (error) {
                if (!(error instanceof ConflictException) || error.message === 'SNAPSHOT_STALE') throw error;
                await this.corrections.clarifyMessage(reference.sessionId, reference.routingId, proposal.routingRevision!, error.message);
              }
            } else await this.plans.commit({ ...reference, actorId: bound.session.ownerId, expectedRoutingRevision: proposal.routingRevision! });
          }
          catch (error) {
            if (error instanceof Error && error.message === 'SNAPSHOT_STALE') {
              await this.mutate(reference, (_draft, _session, route) => { route.status = 'PENDING_RETRY'; route.reasonCodes = ['SNAPSHOT_STALE']; });
              continue;
            }
            throw error;
          }
          return;
        }
        if (proposal.status === 'BLOCKED') { await this.block(reference, proposal.blockedReason ?? 'INTENT_PROCESSING_BLOCKED'); return; }
        if (proposal.reasonCodes.includes('SNAPSHOT_STALE')) continue;
        if (!terminal(proposal)) this.schedule(reference, Math.max(Date.now() + 1000,
          Date.parse(proposal.semanticProposal?.retryAt ?? '') || Date.parse(proposal.leaseExpiresAt ?? '') || Date.now() + 1000));
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ConflictException && !['ROUTING_LEASE_LOST', 'INTENT_PLAN_REVISION_CONFLICT'].includes(error.message)) {
        await this.block(reference, error.message); return;
      }
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  private async block(reference: Reference, code: string) {
    const event = await this.mutate(reference, (draft, session, route) => {
      if (terminal(route) && route.status !== 'BLOCKED') return;
      const eventId = `intent-ingress-blocked:${route.id}${route.recognitionOperationId ? `:${route.recognitionOperationId}` : ''}${route.inputBudgetDecision ? `:${route.inputBudgetDecision.id}` : ''}`;
      const previous = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(row => row.id === eventId);
      if (previous) return;
      const now = new Date().toISOString();
      route.status = 'BLOCKED'; route.blockedReason = code; route.reasonCodes = [code];
      route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = now;
      delete route.leaseOwner; delete route.leaseExpiresAt;
      const event: CollaborationEvent = { id: eventId, sessionId: session.id, type: 'intent_plan_blocked',
        content: code === 'INTENT_INPUT_BUDGET_EXCEEDED' ? '本条消息的输入预算超限，已停止模型请求。请选择继续（仅本次放行）或结束此消息，会话保留。' :
          '当前消息尚未执行。请先处理模型连接或配置问题，再显式重新识别原消息。', toAgentIds: [], createdAt: now,
        actor: { type: 'system', id: 'intent-pipeline' }, metadata: { schemaVersion: '0.1', renderAs: 'system_notice',
          payload: { routingId: route.id, reasonCode: code, failureClass: route.failureClass,
            ...(canRetryIntentRecognition(route) ? { recognitionRetry: { routingId: route.id, sourceEventId: route.sourceEventId,
              dataEpoch: session.dataEpoch, expectedRoutingRevision: route.routingRevision } } : {}) } } };
      appendEvent(draft, event); return event;
    });
    if (event) this.events?.acceptCommitted(event);
  }
  private mutate<T>(reference: Reference, action: (draft: PersistedState, session: SessionDetail, route: IntentRoutingRecord) => T) {
    return this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === reference.sessionId);
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', reference.sessionId).find(row => row.id === reference.routingId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[reference.sessionId];
      if (!session || !route?.semanticContractVersion || session.archivedAt || session.status === 'CANCELLED' ||
        !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch || route.dispatchHold) return;
      if (reference.recognitionOperationId && reference.recognitionOperationId !== (route.recognitionOperationId ?? route.id)) return;
      if (route.semanticIngress && (route.semanticIngress.dataEpoch !== session.dataEpoch || route.semanticIngress.sessionGeneration !== lifecycle.generation)) {
        if (!terminal(route)) { route.status = 'REJECTED'; route.reasonCodes = ['INTENT_GENERATION_STALE']; route.updatedAt = new Date().toISOString(); route.routingRevision = (route.routingRevision ?? 1) + 1; }
        return;
      }
      return action(draft, session, route);
    }, { sessionIds: [reference.sessionId] });
  }
}
function terminal(route: IntentRoutingRecord) { return ['ROUTED', 'BLOCKED', 'REJECTED', 'CLARIFICATION_REQUIRED'].includes(route.status); }
