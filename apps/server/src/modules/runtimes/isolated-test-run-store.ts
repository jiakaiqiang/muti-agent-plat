import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isIsolatedTestScope } from '@agent-cluster/shared';
import type { IntentPlanStepRecord, IntentRouteRevision, IntentRoutingRecord, IsolatedTestAttempt, LogicalOperation, SessionDetail, SessionStopRequest } from '@agent-cluster/shared';
import { currentTestGrant } from '../message-routing/intent-test-authority.js';
import { assertIntentExecutionCurrent, INTENT_EXECUTION_COLLECTIONS } from '../message-routing/intent-execution-guard.js';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import { syncLifecycleStopStatus, type SessionLifecyclesBySession } from './session-lifecycle-store.js';
import { updateStopTarget } from './logical-operation-store.js';
import { appendRuntimeStopStateEvent } from './runtime-stop-event.js';

export type TestRunIdentity = { sessionId: string; dataEpoch: string; operationId: string; invocationId: string };
const collections = ['sessions', 'logicalOperationsBySession', 'sessionLifecyclesBySession', 'sessionStopRequestsBySession',
  'eventsBySession', 'eventOutbox', ...INTENT_EXECUTION_COLLECTIONS];
export const testRunIdentityHash = (identity: TestRunIdentity) => createHash('sha256')
  .update(JSON.stringify([identity.sessionId, identity.dataEpoch, identity.operationId, identity.invocationId])).digest('hex');

/** Uses the existing relational source_snapshot; no process may start before this reservation commits. */
export class IsolatedTestRunStore {
  constructor(private readonly persistence: PersistenceService, private readonly now = Date.now) {}
  authorize(identity: TestRunIdentity, input: { imageId: string; script: string; workingDirectory: string }) {
    return this.mutate(identity, (draft, operation) => {
      this.assertActive(draft, operation, identity);
      const binding = this.assertRunnerBinding(draft, operation, identity, input);
      if (!binding) throw new Error('ISOLATED_TEST_AUTHORITY_REQUIRED');
      return structuredClone(binding);
    });
  }
  async reserve(identity: TestRunIdentity, input: { imageId: string; script: string; ownerId: string; deadlineAt: string; workingDirectory?: string }) {
    return this.mutate(identity, (draft, operation) => {
      this.assertActive(draft, operation, identity);
      const authorityBinding = this.assertRunnerBinding(draft, operation, identity, input);
      if (operation.isolatedTestAttempts?.some(row => row.invocationId === identity.invocationId)) throw new Error('ISOLATED_TEST_ALREADY_RESERVED');
      const now = new Date(this.now()).toISOString(), hash = testRunIdentityHash(identity);
      const row: IsolatedTestAttempt = { ...input, ...(authorityBinding ? { authorityBinding: structuredClone(authorityBinding) } : {}), invocationId: identity.invocationId, identityHash: hash,
        containerName: `intent-test-${hash.slice(0, 40)}`, deadlineAt: new Date(Math.min(Date.parse(input.deadlineAt), Date.parse(operation.deadlineAt))).toISOString(),
        phase: 'reserved', leaseExpiresAt: new Date(this.now() + 30_000).toISOString(), stopConfirmed: true,
        cleanupRequired: false, createdAt: now, updatedAt: now };
      (operation.isolatedTestAttempts ??= []).push(row);
      return structuredClone(row);
    });
  }
  update(identity: TestRunIdentity, ownerId: string, update: Partial<Pick<IsolatedTestAttempt,
    'phase' | 'snapshotDirectory' | 'snapshotHash' | 'daemonId' | 'stopConfirmed' | 'cleanupRequired' | 'result'>>, active = false) {
    return this.mutate(identity, (draft, operation) => {
      const row = this.owned(operation, identity, ownerId);
      if (['finished', 'reconciled'].includes(row.phase)) throw new Error('ISOLATED_TEST_ATTEMPT_TERMINAL');
      for (const key of ['snapshotDirectory', 'snapshotHash', 'daemonId'] as const) {
        if (row[key] !== undefined && update[key] !== undefined && row[key] !== update[key]) throw new Error('ISOLATED_TEST_IDENTITY_MISMATCH');
      }
      if (active) {
        this.assertActive(draft, operation, identity);
        const binding = this.assertRunnerBinding(draft, operation, identity, row);
        if (!isDeepStrictEqual(binding, row.authorityBinding)) throw new Error('ISOLATED_TEST_AUTHORITY_STALE');
        if (Date.parse(row.deadlineAt) <= this.now()) throw new Error('ISOLATED_TEST_TIMEOUT');
      }
      Object.assign(row, structuredClone(update), { leaseExpiresAt: new Date(this.now() + 30_000).toISOString(), updatedAt: new Date(this.now()).toISOString() });
      return structuredClone(row);
    });
  }
  candidates() {
    const operations = this.persistence.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {});
    return Object.values(operations).flatMap(rows => rows.flatMap(operation => (operation.isolatedTestAttempts ?? [])
      .filter(row => !['finished', 'reconciled'].includes(row.phase)).map(row => ({ identity: { sessionId: operation.sessionId,
        dataEpoch: operation.dataEpoch!, operationId: operation.id, invocationId: row.invocationId }, attempt: structuredClone(row) }))));
  }
  claimRecovery(identity: TestRunIdentity, ownerId: string) {
    return this.mutate(identity, (_draft, operation) => {
      const row = operation.isolatedTestAttempts?.find(row => row.invocationId === identity.invocationId);
      if (!row || ['finished', 'reconciled'].includes(row.phase) || Date.parse(row.leaseExpiresAt) > this.now()) return;
      if (row.identityHash !== testRunIdentityHash(identity) || row.containerName !== `intent-test-${row.identityHash.slice(0, 40)}`) throw new Error('ISOLATED_TEST_IDENTITY_MISMATCH');
      row.ownerId = ownerId; row.phase = 'stopping'; row.leaseExpiresAt = new Date(this.now() + 60_000).toISOString();
      row.updatedAt = new Date(this.now()).toISOString();
      // Stop uncertainty prevents other operation reservations while reconciliation is in flight.
      if (operation.activeInvocationId === identity.invocationId) { operation.stopState = 'unconfirmed'; operation.status = 'interrupted'; }
      return structuredClone(row);
    });
  }
  finishRecovery(identity: TestRunIdentity, ownerId: string, confirmed: boolean) {
    return this.mutate(identity, (draft, operation) => {
      const row = this.owned(operation, identity, ownerId);
      row.phase = confirmed ? 'reconciled' : 'reconciliation_required'; row.stopConfirmed = confirmed; row.cleanupRequired = !confirmed;
      row.updatedAt = new Date(this.now()).toISOString(); row.leaseExpiresAt = new Date(this.now() + 30_000).toISOString();
      // The old result is unknown even when the old process is proven stopped. Never fabricate success.
      row.result ??= { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true,
        error: confirmed ? 'ISOLATED_TEST_RESULT_LOST' : 'ISOLATED_TEST_STOP_UNCONFIRMED', outputTruncated: false };
      if (operation.activeInvocationId === identity.invocationId) {
        operation.stopState = confirmed ? 'confirmed' : 'unconfirmed'; operation.status = 'interrupted';
        if (confirmed) delete operation.activeInvocationId;
        operation.updatedAt = row.updatedAt;
        const request = (draft.sessionStopRequestsBySession as Record<string, SessionStopRequest[]> | undefined)?.[identity.sessionId]?.at(-1);
        const changed = updateStopTarget(request, identity.invocationId, confirmed ? 'confirmed' : 'unknown', this.now(), confirmed ? 'adapter_result' : undefined);
        if (request) syncLifecycleStopStatus(draft, identity.sessionId, request.status);
        const sessionExists = (draft.sessions as SessionDetail[] | undefined)?.some(session => session.id === identity.sessionId && session.dataEpoch === identity.dataEpoch);
        if (changed && request && sessionExists) appendRuntimeStopStateEvent(draft, request);
      }
      return structuredClone(row);
    });
  }
  private owned(operation: LogicalOperation, identity: TestRunIdentity, ownerId: string) {
    const row = operation.isolatedTestAttempts?.find(row => row.invocationId === identity.invocationId);
    if (!row || row.ownerId !== ownerId || !(Date.parse(row.leaseExpiresAt) > this.now())) throw new Error('ISOLATED_TEST_LEASE_LOST');
    if (row.identityHash !== testRunIdentityHash(identity)) throw new Error('ISOLATED_TEST_IDENTITY_MISMATCH');
    return row;
  }
  private assertActive(draft: PersistedState, operation: LogicalOperation, identity: TestRunIdentity) {
    const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === identity.sessionId);
    const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[identity.sessionId];
    if (!session || session.dataEpoch !== identity.dataEpoch || session.archivedAt || ['PAUSED', 'CANCELLED', 'COMPLETED', 'INTERRUPTED'].includes(session.status) ||
      !lifecycle || lifecycle.dataEpoch !== identity.dataEpoch || lifecycle.state !== 'active' || lifecycle.admission !== 'open' ||
      lifecycle.generation !== operation.sessionGeneration || operation.activeInvocationId !== identity.invocationId ||
      operation.admissionClass === 'routing' || lifecycle.stopStatus === 'unknown' || operation.status !== 'running' ||
      operation.stopState === 'requested' || operation.stopState === 'unconfirmed' || !(Date.parse(operation.deadlineAt) > this.now())) throw new Error('ISOLATED_TEST_ADMISSION_CLOSED');
    assertIntentExecutionCurrent(draft, { ...operation, invocationId: identity.invocationId });
  }
  private assertRunnerBinding(draft: PersistedState, operation: LogicalOperation, identity: TestRunIdentity,
    input: { imageId: string; script: string; workingDirectory?: string }) {
    const session = (draft.sessions as SessionDetail[]).find(row => row.id === identity.sessionId)!;
    if (!operation.executionBinding && session.intentContractVersion !== 'intent-understanding-v1') return;
    const records = <T>(key: string) => (draft[key] as Record<string, T[]> | undefined)?.[identity.sessionId] ?? [];
    const step = records<IntentPlanStepRecord>('intentPlanStepsBySession').find(row => row.id === operation.intentStepId);
    const route = records<IntentRoutingRecord>('intentRoutingRecordsBySession').find(row => row.id === operation.executionBinding?.routingId);
    const version = records<IntentRouteRevision>('intentRouteRevisionsBySession').find(row => row.routingId === operation.executionBinding?.routingId &&
      row.intentRevision === operation.executionBinding.intentRevision && row.dataEpoch === identity.dataEpoch);
    if (route?.status !== 'ROUTED' || !step || step.sessionId !== identity.sessionId || step.dataEpoch !== identity.dataEpoch ||
      step.routingId !== operation.executionBinding?.routingId || step.intentRevision !== operation.executionBinding.intentRevision ||
      step.status !== 'running' || step.processing?.invocationId !== identity.invocationId ||
      !(Date.parse(step.processing.leaseExpiresAt) > this.now()) || !(Date.parse(step.processing.deadlineAt) > this.now()) ||
      operation.phase !== 'task_execution' || (operation.admissionClass ?? 'business') !== 'business' ||
      !operation.workItemId || step.step.target.workItemId !== operation.workItemId || step.step.target.agentIds.length ||
      !['create_initial_work_item', 'enqueue_follow_up', 'correct_route'].includes(step.step.action) || !isDeepStrictEqual(step.step.executionBinding, operation.executionBinding) ||
      !version?.validatedPlan?.steps.some(saved => isDeepStrictEqual(saved, step.step))) throw new Error('ISOLATED_TEST_STEP_STALE');
    const grant = currentTestGrant(session), binding = session.intentTestAuthority?.binding;
    const scope = step.step.effectScope;
    if (!grant || !binding || !isIsolatedTestScope(scope) ||
      !isDeepStrictEqual(scope.effects.find(effect => effect.kind === 'run_tests')?.target, grant.resource) || !scope.grantIds.includes(grant.id) ||
      scope.prohibitions.some(ban => ban.effectKind === 'run_tests') ||
      !version.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant))) throw new Error('ISOLATED_TEST_AUTHORITY_STALE');
    if (binding.imageId !== input.imageId || binding.script !== input.script ||
      !input.workingDirectory || !isAbsolute(input.workingDirectory) || !session.workingDirectory?.path ||
      !isAbsolute(session.workingDirectory.path) || resolve(input.workingDirectory) !== resolve(session.workingDirectory.path)) {
      throw new Error('ISOLATED_TEST_RUNNER_BINDING_MISMATCH');
    }
    return binding;
  }
  private mutate<T>(identity: TestRunIdentity, action: (draft: PersistedState, operation: LogicalOperation) => T) {
    return this.persistence.mutateCollections(collections, draft => {
      const operation = (draft.logicalOperationsBySession as Record<string, LogicalOperation[]> | undefined)?.[identity.sessionId]
        ?.find(row => row.id === identity.operationId && row.sessionId === identity.sessionId && row.dataEpoch === identity.dataEpoch);
      if (!operation) throw new Error('ISOLATED_TEST_OPERATION_MISSING');
      return action(draft, operation);
    }, { sessionIds: [identity.sessionId] });
  }
}
