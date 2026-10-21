import { randomUUID } from 'node:crypto';
import { canRetryIntentAuthorization, isReadOnlyAnswerScope } from '@agent-cluster/shared';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import type { AgentTask, Artifact, ClarifyIntentRoutingInput, CollaborationEvent, DecisionRecord, IntentContextSnapshot, IntentEffectGrant, IntentPlanStepRecord, IntentResolutionReceipt,
  IntentRouteRevision, IntentRoutingRecord, LogicalOperation, RetryIntentAuthorizationInput, SessionDetail, SessionFollowUpMessage, ValidatedRoutePlan, WorkItem } from '@agent-cluster/shared';
import { appendDecisionInDraft, routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { EventsService } from '../events/events.service.js';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { RuntimeRegistryService } from '../runtimes/runtime-registry.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { compileIntentRoutePlan } from './route-plan-compiler.service.js';
import { appendCorrectionEvent as appendIntentEvent, correctionRows as rows } from './intent-correction-state.js';
import { IntentAnswerExecutorService } from './intent-answer-executor.service.js';
import { currentWorkspaceReadGrant } from './intent-workspace-read.js';
import { currentTestGrant, currentTestReportGrant, intentEffectAuthoritySnapshot } from './intent-test-authority.js';
import { IntentTestExecutorService, isTestStep } from './intent-test-executor.service.js';
import { bindIntentClarification } from './intent-clarification.js';
import { assertSemanticClarificationChoice, semanticClarificationCard } from './semantic-clarification.js';
import { bindAuthorizationRetry } from './intent-authorization-retry.js';
import { deriveIntentBriefStep, deriveCorrectedBriefStep } from './intent-brief-store.service.js';
import { deriveDirectedBriefSteps } from './intent-directed-brief-plan.js';
import { applyBriefRevisionAnswers, assertBriefRevisionPlan } from './intent-brief-revision.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { IntentResumeControlService } from './intent-resume-control.service.js';
import { assertActiveIntentContinuation, assertNoPendingInputBudget, bindIntentResume } from './intent-resume-guard.js';
import { bindIntentRetry } from './intent-retry-guard.js';

const collections = ['sessions', 'sessionLifecyclesBySession', 'intentRoutingRecordsBySession', 'contextSnapshotsBySession',
  'workItemsBySession', 'decisionRecordsBySession', 'tasksBySession', 'logicalOperationsBySession', 'briefsBySession',
  'followUpMessagesBySession', 'intentRouteRevisionsBySession', 'intentResolutionReceiptsBySession', 'intentPlanStepsBySession', 'eventsBySession', 'eventOutbox', 'artifacts',
  'sessionStopRequestsBySession', 'workflowRuntime', 'runtimeInvocationsBySession', 'workspaceWritebacks'];
const localActions = ['create_initial_work_item', 'create_related_work_item', 'create_independent_work_item', 'record_information', 'record_constraint'];

/** Accepts a persisted proposal identity only, never a caller-supplied plan or authority. */
@Injectable()
export class IntentPlanCommitService {
  constructor(private readonly persistence: PersistenceService, private readonly runtimes: RuntimeRegistryService,
    @Optional() private readonly events?: EventsService, @Optional() private readonly answers?: IntentAnswerExecutorService,
    @Optional() private readonly tests?: IntentTestExecutorService, @Optional() private readonly briefs?: IntentBriefExecutorService,
    @Optional() private readonly resumeControl?: IntentResumeControlService) {}

  async commit(input: { sessionId: string; routingId: string; actorId: string; expectedRoutingRevision: number;
    clarification?: ClarifyIntentRoutingInput; clarificationOwner?: string;
    authorizationRetry?: { request: RetryIntentAuthorizationInput; snapshotId: string } }) {
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === input.sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[input.sessionId];
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', input.sessionId).find(row => row.id === input.routingId);
      if (!session || session.ownerId !== input.actorId || session.archivedAt || session.status === 'CANCELLED' ||
        (lifecycle && (lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch))) throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      let proposal = route?.semanticProposal;
      if (proposal?.understanding?.segments.some(segment => ['resume', 'enqueue_follow_up', 'retry_failed_step'].includes(segment.suggestedAction))) {
        assertNoPendingInputBudget(draft, session);
      }
      if (!route || route.sessionId !== session.id || !proposal?.understanding || proposal.dataEpoch !== session.dataEpoch ||
        proposal.sessionGeneration !== lifecycle?.generation) throw new ConflictException('INTENT_PROPOSAL_UNAVAILABLE');
      if (route.dispatchHold) throw new ConflictException('INTENT_DISPATCH_HELD');
      const retry = input.authorizationRetry;
      if (retry && input.clarification) throw new ConflictException('INTENT_OPERATION_CONFLICT');
      const versions = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id);
      if (retry) {
        const receipt = bindAuthorizationRetry(route, input.actorId, retry.request);
        if (rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).some(other => other.id !== route.id &&
          other.authorizationRetryReceipts?.some(row => row.request.idempotencyKey === retry.request.idempotencyKey))) {
          throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
        }
        if (receipt) {
          const version = versions.find(row => row.routingId === route.id && row.intentRevision === receipt.intentRevision);
          if (!version?.validatedPlan || version.authorizationState !== 'validated') throw new ConflictException('INTENT_PLAN_RECEIPT_MISMATCH');
          return { routing: structuredClone(route), plan: structuredClone(version.validatedPlan), idempotentReplay: true };
        }
        proposal = { ...proposal, snapshotId: retry.snapshotId };
      }
      const clarification = input.clarification ? bindIntentClarification(route, rows<CollaborationEvent>(draft, 'eventsBySession', session.id), input.clarification) : undefined;
      if (clarification?.replay) {
        if (!route.semanticPlan) throw new ConflictException('CLARIFICATION_RECEIPT_MISSING');
        return { routing: structuredClone(route), plan: structuredClone(route.semanticPlan), idempotentReplay: true };
      }
      if (clarification) {
        const prepared = route.semanticClarification;
        if (!prepared || prepared.status !== 'ready' || !prepared.understanding || !prepared.snapshotId ||
          prepared.ownerId !== input.clarificationOwner || !input.clarificationOwner || Date.parse(prepared.leaseExpiresAt ?? '') <= Date.now() ||
          Date.parse(prepared.deadlineAt) <= Date.now() || prepared.canonicalChoiceHash !== clarification.canonicalChoiceHash ||
          prepared.actorId !== input.actorId || prepared.dataEpoch !== session.dataEpoch || prepared.sessionGeneration !== lifecycle?.generation) {
          throw new ConflictException('CLARIFICATION_PROPOSAL_UNAVAILABLE');
        }
        assertSemanticClarificationChoice(input.clarification!, clarification.card, prepared.understanding);
        const previousSegment = proposal.understanding!.segments[0], nextSegment = prepared.understanding.segments[0];
        if (nextSegment.requestedEffects.some(effect => !previousSegment.requestedEffects.some(old => old.kind === effect.kind)) ||
          previousSegment.prohibitions.some(ban => !nextSegment.prohibitions.some(next => isDeepStrictEqual(next, ban)))) {
          throw new ConflictException('CLARIFICATION_EFFECT_SCOPE_EXPANDED');
        }
        proposal = { ...proposal, understanding: prepared.understanding, snapshotId: prepared.snapshotId };
      }
      if (route.semanticPlan && !clarification && !retry) {
        const version = versions.find(row => row.routingId === route.id && row.intentRevision === route.semanticPlan!.intentRevision);
        if (route.rolloutMode !== 'shadow' && route.semanticPlan.outcome === 'applicable' && (!version || !isDeepStrictEqual(version.validatedPlan, route.semanticPlan) ||
          !isDeepStrictEqual(version.understanding, proposal.understanding))) throw new ConflictException('INTENT_PLAN_RECEIPT_MISMATCH');
        return { routing: structuredClone(route), plan: structuredClone(route.semanticPlan), idempotentReplay: true };
      }
      if ((!retry && (route.status !== (clarification ? 'CLARIFICATION_REQUIRED' : 'VALIDATING') ||
        route.currentIntentRevision || versions.some(row => row.routingId === route.id))) || route.leaseOwner ||
        route.routingRevision !== input.expectedRoutingRevision) throw new ConflictException('INTENT_PLAN_REVISION_CONFLICT');
      const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(row => row.id === proposal.snapshotId);
      const event = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(row => row.id === route.sourceEventId && row.type === 'user_message');
      if (!snapshot || snapshot.sessionId !== session.id || snapshot.sourceEventId !== route.sourceEventId || (!clarification && !retry && route.snapshotId !== snapshot.id) ||
        !event || event.sessionId !== session.id || snapshot.currentMessage !== event.content) throw new ConflictException('INTENT_SOURCE_BINDING_MISMATCH');
      const works = rows<WorkItem>(draft, 'workItemsBySession', session.id);
      if (clarification && clarification.card.metadata.payload?.businessFingerprint !== routingBusinessFingerprint(session, works,
        rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id))) {
        throw new ConflictException('CLARIFICATION_SNAPSHOT_STALE');
      }
      if (snapshot.businessFingerprint !== routingBusinessFingerprint(session, works,
        rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id))) {
        throw new ConflictException('SNAPSHOT_STALE');
      }
      const understanding = proposal.understanding!;
      const previousRevision = retry ? route.semanticPlan!.intentRevision : clarification ? 1 : null;
      const intentRevision = previousRevision ? previousRevision + 1 : 1;
      const target = works.find(row => row.id === understanding.segments[0]?.target.workItemId);
      if (understanding.segments.some(segment => works.some(work => work.id === segment.target.workItemId && work.dispatchHold))) {
        throw new ConflictException('INTENT_DISPATCH_HELD');
      }
      // Workspace authority is always taken from the live session; old versions cannot regrant it.
      const authority = intentEffectAuthoritySnapshot(session);
      const grants = currentGrants(draft, session, target);
      const readGrant = currentWorkspaceReadGrant(session);
      grants.push(...authority.grants);
      const allowedEffects: Array<'answer' | 'read_workspace' | 'run_tests' | 'write_artifact'> = ['answer', ...(readGrant ? ['read_workspace' as const] : []),
        ...(currentTestGrant(session) ? ['run_tests' as const] : []), ...(currentTestReportGrant(session) ? ['write_artifact' as const] : [])];
      const availableAnswer = this.runtimes.listAll().some(runtime => ['generic_llm', 'mock'].includes(runtime.type) &&
        (!session.runtimePreference?.allowedRuntimeTypes || session.runtimePreference.allowedRuntimeTypes.includes(runtime.type)));
      const availableTests = Boolean(this.tests && this.runtimes.listAll().some(runtime => runtime.type === 'test_runner') &&
        (!session.runtimePreference?.allowedRuntimeTypes || session.runtimePreference.allowedRuntimeTypes.includes('test_runner')));
      const operations = rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id);
      const stopConfirmed = !operations.some(row => row.stopState === 'unconfirmed' || row.stopState === 'requested') &&
        !['unknown', 'requested', 'stopping'].includes(lifecycle?.stopStatus ?? '');
      let retryBinding: import('@agent-cluster/shared').IntentRetryBinding | undefined;
      let retryFailure: { code: string; details?: unknown } | undefined;
      if (session.intentContractVersion === 'intent-understanding-v1' && understanding.segments.some(segment => segment.suggestedAction === 'retry_failed_step')) {
        try { retryBinding = bindIntentRetry(draft, session.id, input.actorId); }
        catch (error) {
          retryFailure = { code: error instanceof Error ? error.message : String(error),
            ...(error instanceof ConflictException && typeof error.getResponse() === 'object' ?
              { details: (error.getResponse() as { details?: unknown }).details } : {}) };
        }
      }
      const plan = compileIntentRoutePlan({ session, routing: route, snapshot, understanding, snapshotCurrent: true,
        intentRevision, requirementRevision: target?.requirementRevision ?? 1, executionEpoch: target?.executionEpoch ?? 1,
        sessionGeneration: lifecycle?.generation ?? 1, stopConfirmed, recoverableCheckpointId: retryBinding?.checkpointId,
        validArtifactIds: ownedArtifacts(draft, session).filter(artifact => snapshot.validArtifactIds?.includes(artifact.id)).map(artifact => artifact.id),
        correctionRoutingIds: (snapshot.correctionCandidates ?? []).map(row => row.routingId),
        scopePolicy: { grants, resources: authority.resources, phaseAllowed: [...allowedEffects],
          toolAllowed: [...allowedEffects], workspaceAllowed: [...allowedEffects], runtimeAllowed: allowedEffects.filter(effect => ['run_tests', 'write_artifact'].includes(effect) ? availableTests : availableAnswer),
          // Transaction-local mutations and the tool-free answer executor cannot write workspace resources.
          enforceableProhibitions: understanding.segments.flatMap(segment => segment.prohibitions.filter(item =>
            item.scope === 'message' && item.effectKind !== 'answer' && item.object.kind === 'workspace' && item.object.refId === session.workspaceId)) } });
      let resumeBinding: import('@agent-cluster/shared').IntentResumeBinding | undefined;
      if (retryFailure) {
        plan.validation.errorCodes = plan.validation.errorCodes.filter(code => code !== 'RETRY_CHECKPOINT_REQUIRED');
        blockPlan(plan, retryFailure.code);
      }
      const pureContinuation = session.intentContractVersion === 'intent-understanding-v1' && understanding.segments.length === 1 &&
        understanding.segments[0].dialogueAct === 'command' && understanding.segments[0].scopeRelation === 'same_requirement' &&
        !understanding.segments[0].requestedEffects.length && !understanding.segments[0].prohibitions.length &&
        !understanding.segments[0].correction && !understanding.segments[0].dependencies.length &&
        !understanding.segments[0].target.agentIds.length && !understanding.segments[0].target.decisionIds.length &&
        !understanding.segments[0].target.artifactIds.length && !understanding.segments[0].target.confirmationId &&
        !understanding.segments[0].target.correctionOfRoutingId;
      if (plan.outcome === 'applicable') {
        const step = plan.steps[0];
        const resume = pureContinuation && step.action === 'resume';
        const continuation = pureContinuation && step.action === 'enqueue_follow_up';
        const retryTask = pureContinuation && step.action === 'retry_failed_step' && Boolean(retryBinding);
        if (step.action === 'retry_failed_step' && !retryTask) blockPlan(plan, 'INTENT_RETRY_EFFECT_CONFLICT');
        if (retryTask && !this.resumeControl?.available && route.rolloutMode !== 'shadow') blockPlan(plan, 'INTENT_ACTION_EXECUTOR_UNAVAILABLE');
        if (resume || continuation) {
          try {
            if (resume) {
              if (!this.resumeControl?.available && route.rolloutMode !== 'shadow') throw new ConflictException('INTENT_ACTION_EXECUTOR_UNAVAILABLE');
              resumeBinding = bindIntentResume(draft, session.id, input.actorId);
            } else assertActiveIntentContinuation(draft, session, step.target.workItemId);
          } catch (error) { blockPlan(plan, error instanceof Error ? error.message : String(error)); }
        }
        assertBriefRevisionPlan(draft, session, route, plan);
        if (step.action === 'correct_route' || (!localActions.includes(step.action) && step.action !== 'answer_in_chat' && !isTestStep(step) && !resume && !continuation && !retryTask)) blockPlan(plan,
          step.action === 'correct_route' ? 'INTENT_CORRECTION_REQUIRES_VERSIONED_ENDPOINT' : 'INTENT_ACTION_EXECUTOR_UNAVAILABLE');
        if (localActions.includes(step.action) && step.effectScope.effects.length && !isTestStep(step)) blockPlan(plan, 'INTENT_LOCAL_ACTION_EFFECT_CONFLICT');
        if (step.action === 'answer_in_chat' && !isReadOnlyAnswerScope(step.effectScope, session.workspaceId)) {
          blockPlan(plan, 'INTENT_ANSWER_SCOPE_REQUIRED');
        }
        if (isTestStep(step) && ((!target && step.action !== 'create_initial_work_item') || step.target.agentIds.length || session.workingDirectory?.kind !== 'server_local' ||
          ['PAUSED', 'COMPLETED', 'CANCELLED', 'INTERRUPTED'].includes(session.status) || lifecycle?.admission !== 'open' || !stopConfirmed)) {
          blockPlan(plan, 'INTENT_TEST_ADMISSION_CLOSED');
        }
        if (isTestStep(step) && target && targetBusy(draft, session.id, target.id)) blockPlan(plan, 'INTENT_TARGET_REQUIRES_STOP');
        if (['record_constraint', 'record_information'].includes(step.action) && target && targetBusy(draft, session.id, target.id)) {
          blockPlan(plan, 'INTENT_TARGET_REQUIRES_STOP');
        }
        if (step.action === 'create_initial_work_item' && works.length) blockPlan(plan, 'INTENT_INITIAL_WORK_ITEM_EXISTS');
        if (step.action === 'create_related_work_item' && target) {
          const allowedDecisions = effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), target).map(row => row.id);
          if (step.target.decisionIds.some(id => !allowedDecisions.includes(id)) ||
            step.target.artifactIds.some(id => !target.inheritedArtifactIds.includes(id) &&
              !ownedArtifacts(draft, session).some(artifact => artifact.id === id && artifact.workItemId === target.id))) blockPlan(plan, 'INTENT_INHERITANCE_OUTSIDE_TARGET');
        }
      }
      if (retry && plan.outcome !== 'applicable') throw new ConflictException({ message: 'INTENT_AUTHORIZATION_RETRY_BLOCKED', reasonCodes: plan.validation.errorCodes });
      if (route.rolloutMode === 'shadow') {
        route.routingRevision = (route.routingRevision ?? 1) + 1;
        plan.routingRevision = route.routingRevision;
        route.semanticPlan = structuredClone(plan);
        route.status = 'ROUTED'; route.updatedAt = new Date().toISOString();
        route.reasonCodes = ['SHADOW_PLAN_EVALUATED', ...plan.validation.errorCodes];
        return { routing: structuredClone(route), plan: structuredClone(plan), idempotentReplay: false };
      }
      const now = new Date().toISOString();
      if (retry) {
        const original = versions.find(row => row.routingId === route.id && row.intentRevision === previousRevision);
        if (original && (!isDeepStrictEqual(original.validatedPlan, route.semanticPlan) ||
          !isDeepStrictEqual(original.understanding, route.semanticProposal!.understanding))) throw new ConflictException('INTENT_PLAN_RECEIPT_MISMATCH');
        if (!original && (previousRevision !== 1 || route.currentIntentRevision)) throw new ConflictException('INTENT_PLAN_RECEIPT_MISMATCH');
        if (!original) versions.push({ id: `intent-revision:${route.id}:${previousRevision}`, sessionId: session.id, dataEpoch: session.dataEpoch,
          routingId: route.id, intentRevision: previousRevision!, previousRevision: null, sourceEventId: route.sourceEventId,
          authorizationState: 'unknown', understanding: structuredClone(route.semanticProposal!.understanding!),
          validatedPlan: structuredClone(route.semanticPlan!), policyVersion: route.semanticPlan!.policyVersion, createdAt: now });
        route.semanticProposal = structuredClone(proposal); route.snapshotId = snapshot.id;
      }
      if (clarification) {
        if (!route.semanticPlan || route.semanticPlan.outcome === 'applicable') throw new ConflictException('CLARIFICATION_NOT_PENDING');
        versions.push({ id: `intent-revision:${route.id}:1`, sessionId: session.id, dataEpoch: session.dataEpoch,
          routingId: route.id, intentRevision: 1, previousRevision: null, sourceEventId: route.sourceEventId,
          authorizationState: 'unknown', understanding: structuredClone(route.semanticProposal!.understanding!),
          validatedPlan: structuredClone(route.semanticPlan), policyVersion: route.semanticPlan.policyVersion, createdAt: now });
        route.semanticProposal = structuredClone(proposal); route.snapshotId = snapshot.id;
      }
      route.routingRevision = (route.routingRevision ?? 1) + 1;
      plan.routingRevision = route.routingRevision;
      route.updatedAt = now;
      route.reasonCodes = [...plan.validation.errorCodes];
      delete route.blockedReason;
      route.status = plan.outcome === 'applicable' ? 'ROUTED' : plan.outcome === 'needs_clarification' ? 'CLARIFICATION_REQUIRED'
        : plan.outcome === 'blocked' ? 'BLOCKED' : 'REJECTED';
      if (plan.outcome === 'blocked') route.blockedReason = plan.validation.errorCodes[0] ?? 'INTENT_PLAN_BLOCKED';
      if (plan.outcome === 'applicable') {
        const step = plan.steps[0];
        let work = target;
        if (step.action.startsWith('create_')) {
          work = { id: randomUUID(), sessionId: session.id, title: step.goal.slice(0, 120), goal: step.goal, status: 'OPEN', revision: 1,
            requirementRevision: 1, executionEpoch: 1, createdFromEventId: route.sourceEventId,
            ...(step.action === 'create_related_work_item' ? { parentWorkItemId: target!.id } : {}),
            inheritedDecisionIds: [...step.target.decisionIds], inheritedArtifactIds: [...step.target.artifactIds], createdAt: now, updatedAt: now };
          works.push(work);
          step.target = { ...step.target, workItemId: work.id };
          const defer = Boolean(session.activeWorkItemId && targetBusy(draft, session.id, session.activeWorkItemId));
          route.deferredActivation = defer;
          if (!defer) { session.activeWorkItemId = work.id; session.revision = (session.revision ?? 1) + 1; session.updatedAt = now; }
        } else if (step.action === 'record_constraint' || (step.action === 'record_information' && work)) {
          if (!work) throw new ConflictException('INTENT_TARGET_REQUIRED');
          appendDecisionInDraft(draft, { session, workItemId: work.id, sourceEventId: route.sourceEventId,
            kind: step.action === 'record_constraint' ? 'constraint' : 'requirement', content: route.briefRevision?.request.userMessage ?? snapshot.currentMessage });
          work.requirementRevision = (work.requirementRevision ?? 1) + 1;
          // Also fence legacy queued invocations that do not carry requirement bindings.
          work.executionEpoch = (work.executionEpoch ?? 1) + 1;
          work.revision += 1; work.updatedAt = now;
        }
        if (work) {
          if (route.briefRevision) applyBriefRevisionAnswers(draft, session, route.briefRevision, route.sourceEventId);
          for (const item of plan.steps) {
            item.executionBinding.requirementRevision = work.requirementRevision ?? 1;
            item.executionBinding.executionEpoch = work.executionEpoch ?? 1;
            item.executionBinding.decisionSetHash = decisionSetHash(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work));
          }
        }
        route.currentIntentRevision = route.effectiveIntentRevision = intentRevision;
        route.executionEpoch = step.executionBinding.executionEpoch;
        if (this.briefs && step.action === 'create_initial_work_item' && !step.effectScope.effects.length && !step.target.agentIds.length &&
          ['DRAFT_INPUT', 'AGENT_DISCUSSING'].includes(session.status) && !session.currentTaskBriefId) plan.steps.push(deriveIntentBriefStep(plan));
        if (route.briefRevision) {
          if (!this.briefs || !work) throw new ConflictException('INTENT_BRIEF_EXECUTOR_UNAVAILABLE');
          const brief = rows<import('@agent-cluster/shared').TaskBrief>(draft, 'briefsBySession', session.id).find(row => row.id === route.briefRevision!.briefId)!;
          plan.steps.push(...(route.briefRevision.reviewerIds?.length
            ? deriveDirectedBriefSteps(plan, brief, work, route.briefRevision.reviewerIds)
            : [deriveCorrectedBriefStep(plan, brief, work)]));
          delete session.pendingBriefRevisionRoutingId;
        }
        route.actionStatus = resumeBinding || retryBinding || step.action === 'answer_in_chat' || isTestStep(step) || plan.steps.some(item => item.action === 'prepare_brief') ? 'pending' : 'applied';
        versions.push({ id: `intent-revision:${route.id}:${intentRevision}`, sessionId: session.id, dataEpoch: session.dataEpoch,
          routingId: route.id, intentRevision, previousRevision, sourceEventId: route.sourceEventId,
          authorizationState: 'validated', authorityGrants: structuredClone(grants.filter(grant => step.effectScope.grantIds.includes(grant.id))), understanding: structuredClone(understanding),
          validatedPlan: structuredClone(plan), policyVersion: plan.policyVersion, createdAt: now });
        for (const item of plan.steps) rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).push({ id: item.stepId, sessionId: session.id,
          dataEpoch: session.dataEpoch, routingId: route.id, intentRevision,
          localKey: item.action === 'answer_in_chat' && item.target.agentIds.length ? JSON.stringify([item.segmentKey, item.target.agentIds[0]]) : item.segmentKey,
          step: structuredClone(item), ...(item.action === 'resume' && resumeBinding ? { resumeBinding } : {}),
          ...(item.action === 'retry_failed_step' && retryBinding ? { retryBinding } : {}),
          status: item.action === 'retry_failed_step' || item.action === 'resume' || item.action === 'answer_in_chat' || item.action === 'prepare_brief' || item.action === 'review_brief' || isTestStep(item) ? 'queued' : 'completed', reusedEffectIds: [], createdAt: now, updatedAt: now });
      }
      route.semanticPlan = structuredClone(plan);
      if (retry) (route.authorizationRetryReceipts ??= []).push({ request: structuredClone(retry.request), actorId: input.actorId,
        intentRevision, resultRoutingRevision: route.routingRevision!, createdAt: now });
      const additionalEvents: CollaborationEvent[] = [];
      if (clarification) {
        route.currentIntentRevision = intentRevision;
        if (plan.outcome !== 'applicable') versions.push({ id: `intent-revision:${route.id}:${intentRevision}`, sessionId: session.id,
          dataEpoch: session.dataEpoch, routingId: route.id, intentRevision, previousRevision: 1, sourceEventId: route.sourceEventId,
          authorizationState: 'unknown', understanding: structuredClone(understanding), validatedPlan: structuredClone(plan), policyVersion: plan.policyVersion, createdAt: now });
        route.resolution = { confirmationId: clarification.confirmationId, choice: input.clarification!.choice,
          canonicalChoiceHash: clarification.canonicalChoiceHash, idempotencyKey: clarification.idempotencyKey,
          resolvedRevision: route.routingRevision!, resultWorkItemId: plan.outcome === 'applicable' ? plan.steps[0]?.target.workItemId ?? undefined : undefined,
          actorId: input.actorId, resolvedAt: now };
        rows<IntentResolutionReceipt>(draft, 'intentResolutionReceiptsBySession', session.id).push({ id: `intent-resolution:${clarification.confirmationId}`,
          sessionId: session.id, dataEpoch: session.dataEpoch, routingId: route.id, resolution: structuredClone(route.resolution), createdAt: now });
        route.semanticClarification!.status = 'completed';
        const resolved: CollaborationEvent = { id: `resolved:${clarification.confirmationId}`, sessionId: session.id,
          type: 'user_confirmation_resolved', actor: { type: 'user', id: input.actorId }, toAgentIds: [], createdAt: now,
          content: '已确认任务关系，执行条件仍单独校验。', metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: {
            confirmationId: clarification.confirmationId, routingId: route.id, routingRevision: route.routingRevision,
            status: 'approved', selectedOptionKey: input.clarification!.choice } } };
        appendIntentEvent(draft, resolved); additionalEvents.push(resolved);
      } else if (plan.outcome === 'needs_clarification') {
        const card = semanticClarificationCard(session, route, snapshot, understanding);
        if (card) { appendIntentEvent(draft, card); card.metadata.payload!.businessFingerprint = routingBusinessFingerprint(session, works,
          rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id));
          // Append stores the same event, while Outbox owns a clone.
          const outbox = draft.eventOutbox as Array<{ id: string; payload: { event: CollaborationEvent } }>;
          outbox.find(row => row.id === `outbox:${card.id}`)!.payload.event = structuredClone(card); additionalEvents.push(card); }
      }
      // Every new-contract outcome belongs to its plan/clarification consumer, never the old Coordinator queue.
      for (const follow of rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', session.id).filter(row => row.routingId === route.id)) {
        if (!['completed', 'failed', 'cancelled'].includes(follow.status)) follow.status = 'cancelled';
      }
      session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(row => row.routingId !== route.id);
      const committedEvent: CollaborationEvent = { id: `intent-plan:${route.id}:${plan.planId}`, sessionId: session.id,
        type: plan.outcome === 'applicable' ? 'intent_plan_committed' : plan.outcome === 'needs_clarification' ? 'intent_plan_clarification_required' : 'intent_plan_blocked',
        content: plan.outcome === 'applicable' ? '已保存消息处理计划。' : canRetryIntentAuthorization(route) ? '当前请求缺少执行授权或可用能力。完成授权后，可重新校验原请求；更新授权不会自动执行。' : plan.outcome === 'needs_clarification' ? '需要补充或确认消息的目标，当前消息尚未执行。' : '当前消息的处理计划未获执行许可。',
        toAgentIds: [], createdAt: now, actor: { type: 'system', id: 'intent-plan' },
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: route.id, routingRevision: route.routingRevision,
          ...(canRetryIntentAuthorization(route) ? { authorizationRetry: { routingId: route.id, dataEpoch: session.dataEpoch,
            expectedRoutingRevision: route.routingRevision, sourceEventId: route.sourceEventId } } : {}),
          ...(understanding.segments.length > 1 ? { multiSegmentReview: {
            contractVersion: 'intent-multi-segment-review-v1', mode: 'clarify_only', sessionId: session.id,
            dataEpoch: session.dataEpoch, routingId: route.id, sourceEventId: route.sourceEventId,
            routingRevision: route.routingRevision, understanding: structuredClone(understanding),
            referenceLabels: [
              ...snapshot.candidateWorkItems.map(row => ({ id: row.id, label: row.title })),
              ...snapshot.validDecisions.map(row => ({ id: row.id, label: row.content })),
              ...(snapshot.validArtifacts ?? []).map(row => ({ id: row.id, label: row.title })),
              ...(snapshot.agentRefs ?? []).map(row => ({ id: row.id, label: row.name }))
            ].filter(row => understanding.segments.some(segment => [segment.target.workItemId, ...segment.target.decisionIds,
              ...segment.target.artifactIds, ...segment.target.agentIds, segment.correction?.supersedesDecisionId].includes(row.id)))
          } } : {}),
          ...(retryFailure?.details ? { retryFailureDetails: retryFailure.details } : {}),
          planId: plan.planId, outcome: plan.outcome, segments: understanding.segments.map(segment => ({ key: segment.localKey, goal: segment.goal,
            action: segment.suggestedAction, dependencies: segment.dependencies })), reasonCodes: plan.validation.errorCodes } } };
      appendIntentEvent(draft, committedEvent);
      return { routing: structuredClone(route), plan: structuredClone(plan), idempotentReplay: false, event: committedEvent, additionalEvents };
    }, { sessionIds: [input.sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    if ('additionalEvents' in result) for (const event of result.additionalEvents ?? []) this.events?.acceptCommitted(event);
    if (result.routing.rolloutMode !== 'shadow' && result.plan.outcome === 'applicable' && result.routing.effectiveIntentRevision === result.plan.intentRevision) {
      if (!result.idempotentReplay) for (const step of result.plan.steps.filter(step => ['resume', 'retry_failed_step'].includes(step.action))) {
        await this.resumeControl!.dispatch({ sessionId: input.sessionId, stepId: step.stepId });
      }
      for (const step of result.plan.steps.filter(step => step.action === 'answer_in_chat')) this.answers?.schedule({ sessionId: input.sessionId, stepId: step.stepId });
      for (const step of result.plan.steps.filter(isTestStep)) this.tests?.schedule({ sessionId: input.sessionId, stepId: step.stepId });
      for (const step of result.plan.steps.filter(step => step.action === 'prepare_brief' || step.action === 'review_brief')) this.briefs?.schedule({ sessionId: input.sessionId, stepId: step.stepId });
    }
    return result;
  }
}

function blockPlan(plan: ValidatedRoutePlan, code: string) {
  plan.outcome = 'blocked'; plan.validation.errorCodes = [...new Set([...plan.validation.errorCodes, code])];
  plan.validation.stateValid = false; plan.validation.validationScore = Math.max(0, 1 - plan.validation.errorCodes.length * 0.1);
}
function ownedArtifacts(draft: PersistedState, session: SessionDetail): Artifact[] {
  const artifacts = draft.artifacts as { artifactsById?: Record<string, Artifact>; artifactIdsBySession?: Record<string, string[]> } | undefined;
  return (artifacts?.artifactIdsBySession?.[session.id] ?? []).map(id => artifacts?.artifactsById?.[id])
    .filter((artifact): artifact is Artifact => Boolean(artifact && artifact.sessionId === session.id && artifact.dataEpoch === session.dataEpoch));
}
function targetBusy(draft: PersistedState, sessionId: string, workItemId: string) {
  return rows<LogicalOperation>(draft, 'logicalOperationsBySession', sessionId).some(row => row.admissionClass !== 'routing' &&
    (row.activeInvocationId || row.stopState === 'unconfirmed' || row.stopState === 'requested') && (!row.workItemId || row.workItemId === workItemId)) ||
    rows<AgentTask>(draft, 'tasksBySession', sessionId).some(row => row.workItemId === workItemId && ['running', 'claimed'].includes(row.status));
}
function currentGrants(draft: PersistedState, session: SessionDetail, target?: WorkItem): IntentEffectGrant[] {
  if (!target) return [];
  const routes = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id);
  const grants = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id).filter(revision =>
    revision.dataEpoch === session.dataEpoch && revision.authorizationState === 'validated' && revision.validatedPlan?.outcome === 'applicable' &&
    revision.validatedPlan.steps.some(step => step.target.workItemId === target.id) && routes.some(route => route.id === revision.routingId &&
      !route.dispatchHold && route.effectiveIntentRevision === revision.intentRevision)).flatMap(row => row.authorityGrants ?? [])
    .filter(grant => !grant.revokedAt && !['read_workspace', 'run_tests', 'write_artifact'].includes(grant.effect));
  const unique = new Map<string, IntentEffectGrant>();
  for (const grant of grants) {
    if (unique.has(grant.id) && !isDeepStrictEqual(unique.get(grant.id), grant)) throw new ConflictException('INTENT_AUTHORITY_CONFLICT');
    unique.set(grant.id, grant);
  }
  return [...unique.values()];
}
