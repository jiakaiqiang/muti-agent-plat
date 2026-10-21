import { createHash } from 'node:crypto';
import type { IntentPlanStepRecord, IntentRouteRevision, IntentRoutingRecord, LogicalOperation, SessionDetail, TaskBrief, WorkItem } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { issueWorkspaceReadAuthority } from './intent-workspace-read.js';

/** Test-only historical execution proof. Never derives authority from the resume message. */
export function seedApprovedResume(state: PersistedState, session: SessionDetail, work: WorkItem) {
  const now = new Date().toISOString();
  session.intentContractVersion = 'intent-understanding-v1'; session.status = 'PAUSED';
  session.currentTaskBriefId = 'approved-brief'; session.activeWorkItemId = work.id;
  session.pauseState = { previousStatus: 'EXECUTING', pausedAt: now, reason: 'pause' };
  session.workingDirectory = { id: session.workspaceId, kind: 'server_local', path: 'D:/fixture', name: 'fixture', selectedAt: now };
  session.workspaceContext = { binding: { workspaceId: session.workspaceId, providerKind: 'server_local', displayName: 'fixture', boundAt: now,
    boundRevision: { id: 'base', observedAt: now }, capabilities: { read: true, write: false, command: false, test: false } } } as SessionDetail['workspaceContext'];
  session.intentWorkspaceReadAuthority = issueWorkspaceReadAuthority(session, 'workspace-selection');
  const grant = session.intentWorkspaceReadAuthority!.grant;
  const body = { effects: [{ kind: 'read_workspace' as const, target: grant.resource, evidenceRefs: ['request'] }], prohibitions: [], grantIds: [grant.id] };
  const effectScope = { ...body, scopeHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  const decisions = (state.decisionRecordsBySession as Record<string, any[]> | undefined)?.[session.id] ?? [];
  const binding = { routingId: 'original-route', intentRevision: 1, requirementRevision: work.requirementRevision ?? 1,
    executionEpoch: work.executionEpoch ?? 1, sessionGeneration: 1, decisionSetHash: decisionSetHash(effectiveDecisions(decisions, work)), effectScopeHash: effectScope.scopeHash };
  const step = { stepId: 'original-step', segmentId: 'original-segment', segmentKey: 'original', action: 'enqueue_follow_up', goal: 'read',
    target: { workItemId: work.id, agentIds: [], decisionIds: [], artifactIds: [], confirmationId: null, correctionOfRoutingId: null },
    contextPolicy: 'inherit_confirmed', correction: null, dependencies: [], evidence: [], expectedSessionStatus: 'EXECUTING',
    effectScope, executionBinding: binding, idempotencyKey: 'original-step' } as IntentPlanStepRecord['step'];
  const revision = { id: 'original-revision', sessionId: session.id, dataEpoch: session.dataEpoch, routingId: 'original-route', intentRevision: 1,
    previousRevision: null, sourceEventId: 'original-message', authorizationState: 'validated', authorityGrants: [grant],
    understanding: null, validatedPlan: { planId: 'original-plan', routingId: 'original-route', routingRevision: 1, intentRevision: 1,
      sourceEventId: 'original-message', snapshotId: 'old-snapshot', businessFingerprint: 'old', policyVersion: 'intent-policy-v1', outcome: 'applicable',
      steps: [step], validation: { schemaValid: true, referencesValid: true, relationActionValid: true, stateValid: true,
        authorizationValid: true, snapshotCurrent: true, validationScore: 1, errorCodes: [] } }, policyVersion: 'intent-policy-v1', createdAt: now } as IntentRouteRevision;
  const append = (key: string, items: unknown[]) => { const map = (state[key] ??= {}) as Record<string, unknown[]>;
    map[session.id] = [...(map[session.id] ?? []), ...structuredClone(items)]; };
  append('intentRoutingRecordsBySession', [{ id: 'original-route', sessionId: session.id, sourceEventId: 'original-message', status: 'ROUTED',
    semanticContractVersion: 'intent-understanding-v1', effectiveIntentRevision: 1, currentIntentRevision: 1 } as IntentRoutingRecord]);
  append('intentRouteRevisionsBySession', [revision]);
  append('intentPlanStepsBySession', [{ id: step.stepId, sessionId: session.id, dataEpoch: session.dataEpoch, routingId: binding.routingId,
    intentRevision: 1, localKey: 'original', step, status: 'running', reusedEffectIds: [], createdAt: now, updatedAt: now } as IntentPlanStepRecord]);
  append('briefsBySession', [{ id: 'approved-brief', sessionId: session.id, workItemId: work.id, version: 1, confirmedByUser: true,
    intentConfirmationReceipt: { id: 'confirmed', actorId: session.ownerId, request: { contractVersion: 'intent-brief-confirm-v1', dataEpoch: session.dataEpoch!,
      confirmationId: 'brief-card', expectedBriefVersion: 1, expectedIntentRevision: 1, idempotencyKey: 'brief-confirm' },
      sourceEventId: 'brief-approved', requirementRevision: work.requirementRevision ?? 1, resultStatus: 'WAIT_WORKFLOW_SELECT', createdAt: now } } as TaskBrief]);
  append('tasksBySession', [{ id: 'original-task', sessionId: session.id, workItemId: work.id, status: 'pending', executionOperationId: 'original-operation' }]);
  append('logicalOperationsBySession', [{ id: 'original-operation', sessionId: session.id, taskId: 'original-task', workItemId: work.id,
    dataEpoch: session.dataEpoch, sessionGeneration: 1, intentStepId: step.stepId, executionBinding: binding, admissionClass: 'business',
    phase: 'task_execution', status: 'paused', stopState: 'confirmed', invocationIds: [], policyVersion: 'execution-reliability-v1',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), remainingActiveMs: 60_000, maxAttempts: 3, attemptsUsed: 1, createdAt: now, updatedAt: now } as LogicalOperation]);
}

export function approvedResumeState(): PersistedState {
  const session = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1 } as SessionDetail;
  const work = { id: 'work', sessionId: 'session', status: 'EXECUTING', revision: 1, requirementRevision: 1, executionEpoch: 1 } as WorkItem;
  const state: PersistedState = { sessions: [session], workItemsBySession: { session: [work] },
    sessionLifecyclesBySession: { session: { contractVersion: 'collaboration-lifecycle-v1', sessionId: 'session', dataEpoch: 'epoch', generation: 1,
      revision: 1, state: 'active', admission: 'closed', stopStatus: 'confirmed' } } };
  seedApprovedResume(state, session, work);
  return state;
}
