import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDependencyFingerprint, derivedCacheKey } from '@agent-cluster/shared';
import { DerivedCache } from '../apps/server/src/modules/context-v2/derived-cache.ts';
import { DiscussionStore } from '../apps/server/src/modules/orchestrator/discussion-store.ts';
import { PersistenceService } from '../apps/server/src/modules/persistence/persistence.service.ts';
import { WorkItemBudgetStore } from '../apps/server/src/modules/runtimes/work-item-budget-store.ts';
import { WorkflowStartStore } from '../apps/server/src/modules/workflows/workflow-start-store.ts';

const NOW = '2026-09-20T00:00:00.000Z';

const scenarios = [
  { id: 'duplicate-submit', expected: 'one-effect', run: duplicateSubmit },
  { id: 'out-of-order-completion', expected: 'stale-rejected', run: outOfOrderCompletion },
  { id: 'crash-after-reserve', expected: 'reclaim-without-duplicate', run: crashAfterReserve },
  { id: 'delete-before-callback', expected: 'audit-only', run: deleteBeforeCallback },
  { id: 'budget-exhausted', expected: 'blocked-without-retry', run: budgetExhausted },
  { id: 'cache-backfill-after-delete', expected: 'rejected-backfill', run: cacheBackfillAfterDelete }
];

function workflowBinding() {
  return {
    sessionId: 'phase6-session',
    workItemId: 'phase6-work-item',
    workItemRevision: 3,
    confirmationId: 'phase6-confirmation',
    documentId: 'phase6-document',
    documentRevision: 2,
    contentHash: 'phase6-document-hash-v2',
    workflowId: 'phase6-workflow',
    workflowVersion: 4,
    definitionHash: 'phase6-workflow-hash-v4'
  };
}

function activeLifecycle(overrides = {}) {
  return {
    contractVersion: 'main-agent-collaboration/v1',
    sessionId: 'phase6-session',
    dataEpoch: 'phase6-epoch',
    generation: 1,
    revision: 1,
    state: 'active',
    admission: 'open',
    stopStatus: 'idle',
    ...overrides
  };
}

async function withFilePersistence(prefix, run) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
  await persistence.initialize();
  try {
    return await run({ persistence, filePath });
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function seedSession(persistence) {
  await persistence.setCollection('sessions', [{ id: 'phase6-session', decisionLedgerRevision: 0 }]);
  await persistence.setCollection('workItemsBySession', {
    'phase6-session': [{ id: 'phase6-work-item', revision: 3 }]
  });
  await persistence.setCollection('sessionLifecyclesBySession', {
    'phase6-session': activeLifecycle()
  });
}

async function duplicateSubmit() {
  return withFilePersistence('phase6-duplicate-submit-', async ({ persistence }) => {
    await seedSession(persistence);
    const firstStore = new WorkflowStartStore(persistence, () => NOW);
    const secondStore = new WorkflowStartStore(persistence, () => NOW);
    const [first, second] = await Promise.all([
      firstStore.submit({ binding: workflowBinding(), generation: 1 }),
      secondStore.submit({ binding: workflowBinding(), generation: 1 })
    ]);
    const submitStatuses = [first.status, second.status].sort();
    const rows = firstStore.list('phase6-session');
    const actual = submitStatuses.join(',') === 'duplicate,submitted' && rows.length === 1
      ? 'one-effect'
      : 'duplicate-effect';
    assert.equal(actual, 'one-effect');
    return {
      component: 'WorkflowStartStore+PersistenceService(file)',
      actual,
      observed: { submitStatuses, persistedRequestCount: rows.length, persistedStatus: rows[0]?.status }
    };
  });
}

async function createDiscussion(persistence) {
  await seedSession(persistence);
  const store = new DiscussionStore(persistence, () => NOW);
  const opened = await store.open({
    sessionId: 'phase6-session',
    workItemId: 'phase6-work-item',
    requirementRevision: 3,
    generation: 1,
    coordinatorAgentId: 'phase6-coordinator',
    objective: 'Validate phase 6 ordering.',
    exitCondition: 'The deterministic state transition is recorded.',
    roundLimit: 2,
    budgetTokens: 2_000
  });
  assert.equal(opened.status, 'opened');
  if (opened.status !== 'opened') throw new Error('DISCUSSION_OPEN_FAILED');
  const reserved = await store.reserveDelegation(opened.run.id, {
    targetAgentId: 'phase6-expert',
    origin: 'coordinator',
    objective: 'Return a bounded report.',
    expectedResult: 'One deterministic report.',
    budgetTokens: 700,
    requirementRevision: 3
  });
  assert.equal(reserved.status, 'reserved');
  if (reserved.status !== 'reserved') throw new Error('DELEGATION_RESERVE_FAILED');
  const running = await store.transitionDelegation(opened.run.id, reserved.delegation.id, {
    status: 'running', invocationId: 'phase6-invocation'
  });
  assert.equal(running.status, 'applied');
  return { store, runId: opened.run.id, delegationId: reserved.delegation.id };
}

function expertReport() {
  return {
    conclusion: 'The transition is deterministic.',
    evidenceRefs: ['phase6-fixture'],
    risks: [],
    openQuestions: [],
    suggestedActions: []
  };
}

async function outOfOrderCompletion() {
  return withFilePersistence('phase6-out-of-order-', async ({ persistence }) => {
    const { store, runId, delegationId } = await createDiscussion(persistence);
    const completed = await store.transitionDelegation(runId, delegationId, {
      status: 'completed', result: expertReport()
    });
    const replay = await store.transitionDelegation(runId, delegationId, {
      status: 'completed', result: expertReport()
    });
    const stale = await store.transitionDelegation(runId, delegationId, { status: 'running' });
    const storedStatus = store.get('phase6-session', runId)?.delegations[0]?.status;
    const staleCode = stale.status === 'rejected' ? stale.code : undefined;
    const actual = completed.status === 'applied' && replay.status === 'idempotent' &&
      staleCode === 'DELEGATION_INVALID_TRANSITION' && storedStatus === 'completed'
      ? 'stale-rejected'
      : 'stale-applied';
    assert.equal(actual, 'stale-rejected');
    return {
      component: 'DiscussionStore+PersistenceService(file)',
      actual,
      observed: {
        completionStatus: completed.status,
        replayStatus: replay.status,
        staleTransitionCode: staleCode,
        persistedDelegationStatus: storedStatus
      }
    };
  });
}

async function crashAfterReserve() {
  const directory = mkdtempSync(join(tmpdir(), 'phase6-crash-after-reserve-'));
  const filePath = join(directory, 'state.json');
  const beforeCrash = new PersistenceService({ enabled: true, backend: 'file', filePath });
  let afterRestart;
  try {
    await beforeCrash.initialize();
    await seedSession(beforeCrash);
    const initialStore = new WorkflowStartStore(beforeCrash, () => NOW);
    const submitted = await initialStore.submit({ binding: workflowBinding(), generation: 1 });
    assert.equal(submitted.status, 'submitted');
    if (submitted.status !== 'submitted') throw new Error('WORKFLOW_SUBMIT_FAILED');
    const requestId = submitted.request.id;
    const claimed = await initialStore.claim(requestId, { workerId: 'phase6-crashed-worker' });
    assert.equal(claimed.status, 'claimed');
    await beforeCrash.onModuleDestroy();

    afterRestart = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await afterRestart.initialize();
    const recoveredStore = new WorkflowStartStore(afterRestart, () => NOW);
    const recoverableIds = recoveredStore.recoverable('phase6-session').map((item) => item.id);
    const reclaimed = await recoveredStore.claim(requestId, {
      workerId: 'phase6-recovery-worker', reclaimDispatched: true
    });
    const completed = await recoveredStore.complete(requestId, { workflowRunId: 'phase6-run-authoritative' });
    const duplicateCompletion = await recoveredStore.complete(requestId, { workflowRunId: 'phase6-run-duplicate' });
    const rows = recoveredStore.list('phase6-session');
    const authoritativeRunPreserved = rows[0]?.workflowRunId === 'phase6-run-authoritative';
    const actual = recoverableIds.length === 1 && recoverableIds[0] === requestId &&
      reclaimed.status === 'claimed' && completed.status === 'completed' &&
      duplicateCompletion.status === 'idempotent' && rows.length === 1 && authoritativeRunPreserved
      ? 'reclaim-without-duplicate'
      : 'duplicate-or-lost';
    assert.equal(actual, 'reclaim-without-duplicate');
    return {
      component: 'WorkflowStartStore+PersistenceService(file restart)',
      actual,
      observed: {
        recoverableRequestCount: recoverableIds.length,
        reclaimStatus: reclaimed.status,
        duplicateCompletionStatus: duplicateCompletion.status,
        persistedRequestCount: rows.length,
        authoritativeRunPreserved
      }
    };
  } finally {
    await beforeCrash.onModuleDestroy().catch(() => undefined);
    await afterRestart?.onModuleDestroy().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function deleteBeforeCallback() {
  return withFilePersistence('phase6-delete-before-callback-', async ({ persistence }) => {
    const { store, runId, delegationId } = await createDiscussion(persistence);
    await persistence.setCollection('sessionLifecyclesBySession', {
      'phase6-session': activeLifecycle({ revision: 2, state: 'deleting', admission: 'closed', stopStatus: 'requested' })
    });
    const lateCallback = await store.transitionDelegation(runId, delegationId, {
      status: 'completed', result: expertReport()
    });
    const persistedStatus = store.get('phase6-session', runId)?.delegations[0]?.status;
    const callbackCode = lateCallback.status === 'rejected' ? lateCallback.code : undefined;
    const resultPersisted = Boolean(store.get('phase6-session', runId)?.delegations[0]?.result);
    const actual = callbackCode === 'SESSION_ADMISSION_CLOSED' && persistedStatus === 'running' && !resultPersisted
      ? 'audit-only'
      : 'late-result-applied';
    assert.equal(actual, 'audit-only');
    return {
      component: 'DiscussionStore+session lifecycle admission(file)',
      actual,
      observed: {
        callbackCode,
        persistedDelegationStatus: persistedStatus,
        resultPersisted
      }
    };
  });
}

async function budgetExhausted() {
  return withFilePersistence('phase6-budget-exhausted-', async ({ persistence }) => {
    const store = new WorkItemBudgetStore(persistence, () => NOW);
    const first = await store.reserve({
      sessionId: 'phase6-session', workItemId: 'phase6-work-item', attemptId: 'phase6-attempt-a',
      operationId: 'phase6-operation-a', category: 'execution', requestedTokens: 700, limitTokens: 1_000, now: NOW
    });
    const second = await store.reserve({
      sessionId: 'phase6-session', workItemId: 'phase6-work-item', attemptId: 'phase6-attempt-b',
      operationId: 'phase6-operation-b', category: 'execution', requestedTokens: 700, limitTokens: 1_000, now: NOW
    });
    const ledger = store.get('phase6-session', 'phase6-work-item');
    const availableTokens = store.available('phase6-session', 'phase6-work-item');
    const actual = first.status === 'reserved' && second.status === 'insufficient' &&
      ledger?.reservedTokens === 700 && availableTokens === 300
      ? 'blocked-without-retry'
      : 'double-spent';
    assert.equal(actual, 'blocked-without-retry');
    return {
      component: 'WorkItemBudgetStore+PersistenceService(file)',
      actual,
      observed: {
        firstReservationStatus: first.status,
        secondReservationStatus: second.status,
        persistedReservedTokens: ledger?.reservedTokens,
        availableTokens
      }
    };
  });
}

async function cacheBackfillAfterDelete() {
  const cache = new DerivedCache({ maxEntries: 4, ttlMs: 60_000 });
  const key = derivedCacheKey({
    layer: 'context_bundle',
    scope: {
      kind: 'private', sessionId: 'phase6-session', workItemId: 'phase6-work-item',
      agentId: 'phase6-agent', generation: 1
    },
    dependencyFingerprint: cacheDependencyFingerprint({
      workItemRevision: 3,
      decisionLedgerRevision: 1,
      fileHashes: { 'phase6-fixture.ts': 'phase6-hash' },
      toolCatalogVersion: 'phase6-tools-v1',
      policyVersion: 'phase6-policy-v1',
      modelConfigVersion: 'phase6-model-v1'
    })
  });
  assert.equal(cache.set(key, 'current-value', { sessionId: 'phase6-session', generation: 1 }), true);
  const invalidatedEntries = cache.invalidateSession('phase6-session');
  const accepted = cache.set(key, 'late-value', { sessionId: 'phase6-session', generation: 2 });
  const stats = cache.stats();
  const actual = invalidatedEntries === 1 && !accepted && stats.size === 0 && stats.rejectedBackfills === 1
    ? 'rejected-backfill'
    : 'stale-backfill-accepted';
  assert.equal(actual, 'rejected-backfill');
  return {
    component: 'DerivedCache+derivedCacheKey',
    actual,
    observed: { invalidatedEntries, backfillAccepted: accepted, cacheSize: stats.size, rejectedBackfills: stats.rejectedBackfills }
  };
}

export async function runFaultMatrix() {
  const evidence = [];
  for (const scenario of scenarios) {
    try {
      const outcome = await scenario.run();
      evidence.push({
        id: scenario.id,
        expected: scenario.expected,
        ...outcome,
        status: outcome.actual === scenario.expected ? 'passed' : 'failed'
      });
    } catch (error) {
      evidence.push({
        id: scenario.id,
        expected: scenario.expected,
        actual: 'error',
        status: 'failed',
        component: 'scenario-runner',
        observed: { errorName: error instanceof Error ? error.name : 'UnknownError' }
      });
    }
  }
  return {
    scenarios: evidence,
    allDeterministicChecksPassed: evidence.every((item) => item.status === 'passed'),
    backend: 'file',
    postgres: 'not executed: RELATIONAL_TEST_DATABASE_URL is not configured for this entrypoint',
    cliStub: 'not applicable: real file-backed stores and cache are exercised'
  };
}

if (process.argv[1]?.endsWith('phase-6-fault-matrix.mjs')) {
  const report = await runFaultMatrix();
  assert.equal(report.allDeterministicChecksPassed, true);
  console.log(JSON.stringify(report, null, 2));
}
