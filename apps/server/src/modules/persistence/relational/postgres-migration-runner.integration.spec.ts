import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { ContentReferenceCodec } from '../content-reference-codec.js';
import { LocalContentStore } from '../local-content-store.js';
import { PersistenceService } from '../persistence.service.js';
import { runPostgresMigrations } from './postgres-migration-runner.js';
import { RelationalStateStore } from './relational-state-store.js';
import { LogicalOperationStore } from '../../runtimes/logical-operation-store.js';
import { SessionStopStateStore } from '../../runtimes/session-stop-state-store.js';
import { SessionLifecycleStore } from '../../runtimes/session-lifecycle-store.js';
import { WorkItemBudgetStore } from '../../runtimes/work-item-budget-store.js';
import { SummaryCheckpointStore, type SummaryCheckpointDraft } from '../../memory/summary-checkpoint-store.js';
import { DiscussionStore } from '../../orchestrator/discussion-store.js';

const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL;

test('PostgreSQL serializes delete admission against reserve and restores only a paused generation', { skip: !databaseUrl }, async () => {
  const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const sessionId = `lifecycle-race-${process.pid}-${Date.now()}`;
  const siblingId = `${sessionId}-sibling`;
  const now = new Date().toISOString();
  try {
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []),
      { id: sessionId, dataEpoch: first.currentDataEpoch(), title: 'Lifecycle race', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now },
      { id: siblingId, dataEpoch: first.currentDataEpoch(), title: 'Sibling', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now }
    ]);
    const firstLifecycle = new SessionLifecycleStore(first);
    await firstLifecycle.initialize(sessionId, first.currentDataEpoch());
    await firstLifecycle.initialize(siblingId, first.currentDataEpoch());
    const firstOperations = new LogicalOperationStore(first);
    const operation = await firstOperations.begin({ id: `op-${sessionId}`, sessionId, phase: 'task_execution' });
    const siblingOperation = await firstOperations.begin({ id: `op-${siblingId}`, sessionId: siblingId, phase: 'task_execution' });
    await second.initialize();
    const secondLifecycle = new SessionLifecycleStore(second);
    const secondOperations = new LogicalOperationStore(second);

    const [deletion, reservation] = await Promise.allSettled([
      secondLifecycle.beginDelete(sessionId, second.currentDataEpoch(), `delete-${sessionId}`),
      firstOperations.reserve(sessionId, operation.id, `call-${sessionId}`)
    ]);
    assert.equal(deletion.status, 'fulfilled');
    assert.equal(secondLifecycle.get(sessionId)?.state, 'deleting');
    await assert.rejects(secondOperations.reserve(sessionId, operation.id, `call-after-delete-${sessionId}`),
      /SESSION_ADMISSION_CLOSED/);
    await secondOperations.reserve(siblingId, siblingOperation.id, `call-${siblingId}`);

    const activeInvocation = reservation.status === 'fulfilled' ? reservation.value.activeInvocationId : undefined;
    const stops = new SessionStopStateStore(second);
    await stops.request(sessionId, 'delete', activeInvocation ? [activeInvocation] : []);
    if (activeInvocation) await secondOperations.settle(sessionId, operation.id, activeInvocation, 'confirmed', true);
    const deleted = await secondLifecycle.completeDelete(sessionId);
    assert.equal(deleted.lifecycle.state, 'deleted');
    const restoredLifecycle = await secondLifecycle.restore(sessionId, {
      requestId: `restore-${sessionId}`,
      expectedGeneration: deleted.lifecycle.generation
    });
    assert.equal(restoredLifecycle.lifecycle.state, 'active');
    assert.equal(restoredLifecycle.lifecycle.admission, 'closed');

    await restored.initialize();
    assert.equal(new SessionLifecycleStore(restored).get(sessionId)?.generation, deleted.lifecycle.generation + 1);
    assert.equal(restored.getCollection<any[]>('sessions', []).find(item => item.id === sessionId)?.status, 'PAUSED');
    assert.equal(new LogicalOperationStore(restored).list(siblingId)[0]?.activeInvocationId, `call-${siblingId}`);
  } finally {
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy(), restored.onModuleDestroy()]);
  }
});

test('online PostgreSQL mutations preserve concurrent sessions and are independent of event/outbox revisions', { skip: !databaseUrl }, async () => {
  const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const sessionId = `scoped-${process.pid}-${Date.now()}`;
  const now = new Date().toISOString();
  try {
    await first.initialize();
    const session = { id: sessionId, title: 'initial', status: 'FAILED', ownerId: 'test', createdAt: now, updatedAt: now };
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []), session]);
    await second.initialize();
    const staleSessions = second.getCollection<any[]>('sessions', []);
    await first.mutateCollections(['sessions'], draft => {
      const sessions = draft.sessions as any[];
      sessions.find(item => item.id === sessionId).status = 'AGENT_DISCUSSING';
      sessions.push({ ...session, id: `${sessionId}-concurrent`, title: 'concurrent addition' });
    });
    staleSessions.find(item => item.id === sessionId).title = 'local title edit';
    assert.equal(await second.setCollection('sessions', staleSessions), true);
    const operations = new LogicalOperationStore(first);
    const event = { id: `${sessionId}-event`, sessionId, type: 'user_message' as const, toAgentIds: [],
      content: 'concurrent event', metadata: { schemaVersion: '0.1' as const, payload: {} }, createdAt: now };
    // first's full state revision is now stale, including missing outbox fields.
    await second.appendEvent(event);
    const claimed = await second.claimPendingEventOutbox('test-worker', 100);
    assert.ok(claimed.some(item => item.id === `outbox:${event.id}`));
    await Promise.all([
      second.markEventPublished(event.id),
      operations.begin({ id: `${sessionId}-operation`, sessionId, phase: 'brief_generation' })
    ]);
    await operations.reserve(sessionId, `${sessionId}-operation`, `${sessionId}-invocation`);
    await assert.rejects(first.mutateStateAtomically(first.stateRevision(), draft => {
      (draft.sessions as any[]).find(item => item.id === sessionId).title = 'stale maintenance overwrite';
    }), /PERSISTENCE_REVISION_CONFLICT/);
    await first.mutateCollections(['sessions', 'eventsBySession', 'eventOutbox'], draft => {
      (draft.sessions as any[]).find(item => item.id === sessionId).tokenUsed = 42;
    });
    await assert.rejects(first.mutateCollections(['sessions'], draft => {
      (draft.sessions as any[]).find(item => item.id === sessionId).title = 'rolled back';
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    await assert.rejects(first.mutateCollections(['sessions'], async () => {}), /MUST_BE_SYNCHRONOUS/);
    await assert.rejects(first.mutateCollections(['sessions'], draft => { draft.eventOutbox = []; }), /OUTSIDE_SCOPE/);
    await restored.initialize();
    const saved = restored.getCollection<any[]>('sessions', []);
    assert.equal(saved.find(item => item.id === sessionId).title, 'local title edit');
    assert.equal(saved.find(item => item.id === sessionId).status, 'AGENT_DISCUSSING');
    assert.equal(saved.find(item => item.id === sessionId).tokenUsed, 42);
    assert.ok(saved.some(item => item.id === `${sessionId}-concurrent`));
    assert.equal(restored.getCollection<any[]>('eventOutbox', []).find(item => item.id === `outbox:${event.id}`).status, 'published');
    assert.equal(new LogicalOperationStore(restored).list(sessionId)[0].attemptsUsed, 1);
  } finally { await Promise.all([first, second, restored].map(service => service.onModuleDestroy())); }
});

test('PostgreSQL commit blocked by a collection lock preserves new local messages and status edits', { skip: !databaseUrl }, async () => {
  const service = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl });
  const blocker = await pool.connect();
  const sessionId = `delayed-${process.pid}-${Date.now()}`;
  const now = new Date().toISOString();
  try {
    await service.initialize();
    await service.setCollection('sessions', [...service.getCollection<any[]>('sessions', []), {
      id: sessionId, title: 'before', status: 'FAILED', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(hashtext($1))', ['agent_cluster:collection:eventOutbox']);
    const store = (service as any).relationalStore;
    const original = store.mutateCollections.bind(store);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    store.mutateCollections = (...args: unknown[]) => { entered(); return original(...args); };
    const transaction = service.mutateCollections(['sessions', 'eventsBySession', 'eventOutbox'], draft => {
      (draft.sessions as any[]).find(item => item.id === sessionId).status = 'AGENT_DISCUSSING';
    });
    await started;
    const local = service.getCollection<any[]>('sessions', []);
    local.find(item => item.id === sessionId).title = 'typed while committing';
    const write = service.setCollection('sessions', local);
    const event = { id: `${sessionId}-event`, sessionId, type: 'user_message' as const, toAgentIds: [],
      content: 'message during commit', metadata: { schemaVersion: '0.1' as const, payload: {} }, createdAt: now };
    const append = service.appendEvent(event);
    await blocker.query('commit');
    await Promise.all([transaction, write, append]);
    await service.flush();
    assert.equal(service.getCollection<any[]>('sessions', []).find(item => item.id === sessionId).status, 'AGENT_DISCUSSING');
    assert.equal(service.getCollection<any[]>('sessions', []).find(item => item.id === sessionId).title, 'typed while committing');
    assert.ok(service.getCollection<Record<string, any[]>>('eventsBySession', {})[sessionId].some(item => item.id === event.id));
    await restored.initialize();
    assert.deepEqual(restored.getCollection<Record<string, any[]>>('eventsBySession', {})[sessionId], [event]);
    assert.equal(restored.getCollection<any[]>('sessions', []).find(item => item.id === sessionId).status, 'AGENT_DISCUSSING');
    assert.equal(restored.getCollection<any[]>('sessions', []).find(item => item.id === sessionId).title, 'typed while committing');
  } finally {
    await blocker.query('rollback').catch(() => undefined);
    blocker.release();
    await Promise.all([service.onModuleDestroy(), restored.onModuleDestroy(), pool.end()]);
  }
});

test('PostgreSQL logical operations reserve atomically and retain stop barriers across process reconstruction', { skip: !databaseUrl }, async () => {
  const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const sessionId = `operation-session-${process.pid}-${Date.now()}`;
  const now = new Date().toISOString();
  try {
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []), {
      id: sessionId, title: 'Logical operation integration', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    const firstStore = new LogicalOperationStore(first);
    const operation = await firstStore.begin({ id: `op-${sessionId}`, sessionId, phase: 'user_message_routing' });
    await second.initialize();
    const secondStore = new LogicalOperationStore(second);
    const binding = { transport: { deviceId: 'test-device', workspaceId: 'test-workspace', runtimeType: 'codex' as const } };
    const reservations = await Promise.allSettled([
      firstStore.reserve(sessionId, operation.id, 'call-first', binding),
      secondStore.reserve(sessionId, operation.id, 'call-second', binding)
    ]);
    assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1);
    const ownerService = reservations[0]?.status === 'fulfilled' ? first : second;
    const ownerStore = reservations[0]?.status === 'fulfilled' ? firstStore : secondStore;
    const activeInvocationId = ownerStore.list(sessionId)[0]?.activeInvocationId;
    assert.ok(activeInvocationId);
    const requested = await new SessionStopStateStore(ownerService).request(sessionId, 'integration_stop', [activeInvocationId]);
    await restored.initialize();
    const restoredStore = new LogicalOperationStore(restored);
    const [saved] = restoredStore.list(sessionId);
    assert.equal(saved.attemptsUsed, 1);
    assert.equal(saved.deadlineAt, operation.deadlineAt);
    assert.equal(restoredStore.hasUnknownStop(sessionId), true);
    assert.equal(await restoredStore.confirmTransportResult(saved.activeInvocationId!, binding.transport), true);
    assert.equal(restoredStore.hasUnknownStop(sessionId), false);
    const restoredStop = new SessionStopStateStore(restored).summary(sessionId);
    assert.equal(restoredStop.stopRequestId, requested.id);
    assert.equal(restoredStop.status, 'confirmed');
    assert.equal(restoredStop.version, 2);
    await restoredStore.reserve(sessionId, operation.id, 'call-after-restart', binding);
    await restoredStore.settle(sessionId, operation.id, 'call-after-restart');
    await assert.rejects(restoredStore.reserve(sessionId, operation.id, 'over-budget'), /BUDGET_EXHAUSTED/);
  } finally {
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy(), restored.onModuleDestroy()]);
  }
});

test('PostgreSQL rejects a reserve racing a paused zero-target stop until the Session is resumed', { skip: !databaseUrl }, async () => {
  const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const sessionId = `paused-stop-race-${process.pid}-${Date.now()}`;
  const now = new Date().toISOString();
  try {
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []), {
      id: sessionId, title: 'Paused stop race', status: 'PAUSED', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    const operations = new LogicalOperationStore(first);
    await operations.begin({ id: `op-${sessionId}`, sessionId, phase: 'task_execution' });
    await second.initialize();
    const stops = new SessionStopStateStore(second);

    const [stopResult, reserveResult] = await Promise.allSettled([
      stops.request(sessionId, 'user_paused'),
      operations.reserve(sessionId, `op-${sessionId}`, `call-${sessionId}`)
    ]);
    assert.equal(stopResult.status, 'fulfilled');
    assert.equal(stopResult.status === 'fulfilled' ? stopResult.value.status : undefined, 'confirmed');
    assert.equal(reserveResult.status, 'rejected');
    assert.match(String(reserveResult.status === 'rejected' ? reserveResult.reason : ''), /OPERATION_STOP_UNCONFIRMED/);

    await restored.initialize();
    assert.equal(new LogicalOperationStore(restored).list(sessionId)[0]?.activeInvocationId, undefined);
    assert.equal(new SessionStopStateStore(restored).summary(sessionId).status, 'confirmed');

    const sessions = first.getCollection<any[]>('sessions', []);
    sessions.find(item => item.id === sessionId).status = 'EXECUTING';
    await first.setCollection('sessions', sessions);
    await operations.reserve(sessionId, `op-${sessionId}`, `call-after-resume-${sessionId}`);
  } finally {
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy(), restored.onModuleDestroy()]);
  }
});

test('PostgreSQL deduplicates cross-connection stop receipt replay and recovers its pending outbox', { skip: !databaseUrl }, async () => {
  const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
  const sessionId = `stop-receipt-replay-${process.pid}-${Date.now()}`;
  const operationId = `op-${sessionId}`;
  const invocationId = `call-${sessionId}`;
  const now = new Date().toISOString();
  const appNow = () => Date.now() + 60_000;
  const transport = { deviceId: 'test-device', workspaceId: 'test-workspace', runtimeType: 'codex' as const };
  try {
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []), {
      id: sessionId, title: 'Stop receipt replay', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    const firstOperations = new LogicalOperationStore(first, appNow);
    await firstOperations.begin({ id: operationId, sessionId, phase: 'task_execution' });
    await firstOperations.reserve(sessionId, operationId, invocationId, { transport });
    const sessions = first.getCollection<any[]>('sessions', []);
    sessions.find(item => item.id === sessionId).status = 'PAUSED';
    await first.setCollection('sessions', sessions);
    const request = await new SessionStopStateStore(first, appNow).request(sessionId, 'user_paused');
    await firstOperations.settle(sessionId, operationId, invocationId, 'unconfirmed', true);
    await second.initialize();
    const secondOperations = new LogicalOperationStore(second, appNow);

    const receipts = await Promise.all([
      firstOperations.confirmTransportReceipt(invocationId, transport),
      secondOperations.confirmTransportReceipt(invocationId, transport)
    ]);
    assert.equal(receipts.every(receipt => receipt.confirmed), true);
    assert.equal(receipts.filter(receipt => receipt.alreadyConfirmed).length, 1);

    await restored.initialize();
    const summary = new SessionStopStateStore(restored).summary(sessionId);
    assert.equal(summary.stopRequestId, request.id);
    assert.equal(summary.status, 'confirmed');
    assert.equal(summary.version, 3);
    const stopEvents = restored.getCollection<Record<string, any[]>>('eventsBySession', {})[sessionId]
      .filter(event => event.metadata?.payload?.code === 'RUNTIME_STOP_STATE_CHANGED');
    assert.deepEqual(stopEvents.map(event => event.metadata.payload.version), [1, 2, 3]);
    assert.equal(new Set(stopEvents.map(event => event.id)).size, 3);
    const stopOutbox = restored.getCollection<any[]>('eventOutbox', [])
      .filter(record => stopEvents.some(event => record.id === `outbox:${event.id}`));
    assert.equal(stopOutbox.length, 3);
    const claimedAfterRestart = await restored.claimPendingEventOutbox('restart-worker', 100);
    assert.equal(claimedAfterRestart.filter(record => record.id === `outbox:runtime-stop:${request.id}:3`).length, 1);
  } finally {
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy(), restored.onModuleDestroy()]);
  }
});

test('PostgreSQL migration creates a fully commented relational schema and is idempotent', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runPostgresMigrations(pool);
    await runPostgresMigrations(pool);

    const tables = await pool.query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
       order by c.relname
    `);
    assert.ok(tables.rows.length >= 49);

    const missingComments = await pool.query<{ object_name: string }>(`
      select c.relname as object_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
         and obj_description(c.oid, 'pg_class') is null
      union all
      select c.relname || '.' || a.attname as object_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
         and a.attnum > 0
         and not a.attisdropped
         and col_description(c.oid, a.attnum) is null
    `);
    assert.deepEqual(missingComments.rows, []);
  } finally {
    await pool.end();
  }
});


test('relational projections preserve catalog versions, bindings, session progress, context requests, and outbox', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const competingPool = new Pool({ connectionString: databaseUrl });
  const contentRoot = mkdtempSync(join(tmpdir(), 'agent-cluster-relational-'));
  const suffix = `${process.pid}-${Date.now()}`;
  const agentId = `agent-${suffix}`;
  const skillId = `skill-${suffix}`;
  const capabilityId = `cap-${suffix}`;
  const knowledgeId = `knowledge-${suffix}`;
  const sessionId = `session-${suffix}`;
  const taskId = `task-${suffix}`;
  const contextRequestId = `context-${suffix}`;
  const eventId = `event-${suffix}`;
  const toolName = `tool_${suffix.replace(/-/g, '_')}`;
  const now = new Date().toISOString();
  try {
    await runPostgresMigrations(pool);
    const store = new RelationalStateStore(
      pool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    const competingStore = new RelationalStateStore(
      competingPool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    await store.writeCollection('agents', [{
      id: agentId, key: agentId, name: 'Projection Agent', role: 'worker', profileRevision: 1,
      profileMarkdown: `Use \${skill:${skillId}}`, capabilityIds: [capabilityId],
      defaultKnowledgeBaseIds: [knowledgeId], createdAt: now, updatedAt: now
    }]);
    await store.writeCollection('skills', [{
      id: skillId, key: skillId, name: 'Projection Skill', content: 'skill body', revision: 1,
      createdAt: now, updatedAt: now
    }]);
    await store.writeCollection('capabilities', {
      capabilities: [{ id: capabilityId, key: `tool.${suffix}`, kind: 'tool', name: 'Projection Tool', riskLevel: 'low' }],
      approvals: [], definitionExtensions: {}
    });
    await store.writeCollection('knowledge', {
      knowledgeBases: { [knowledgeId]: { name: 'Projection Knowledge', scope: 'global', ownerId: 'local-user', updatedAt: now } },
      documentsByBase: {}, chunksByBase: {}
    });
    const tool = {
      name: toolName, description: 'version one', category: 'custom', riskLevel: 'low',
      inputSchema: { type: 'object' }, provider: 'agent-cluster', toolType: 'builtin',
      capabilityExternalIds: [capabilityId]
    };
    await store.writeToolDefinitions([tool]);
    await store.writeToolDefinitions([tool]);
    await store.writeToolDefinitions([{ ...tool, description: 'version two' }]);

    const session = {
      id: sessionId, title: 'Projection Session', status: 'USER_INPUT', ownerId: 'local-user',
      createdAt: now, updatedAt: now,
      supplementalContextRequests: [{
        id: contextRequestId, taskId, agentId,
        requestedContext: { reason: 'Need source', requestedRefs: [], requestedPaths: ['src/a.ts'], requestedCommands: [] },
        resolution: { hydratedPaths: ['src/a.ts'], failedPaths: [], deferredPaths: [] },
        createdAt: now, updatedAt: now
      }]
    };
    await store.writeCollection('sessions', [session]);
    const revisionBaseline = {
      id: `baseline-${suffix}`,
      dataEpoch: `epoch-${suffix}`,
      sessionId,
      workspaceId: `workspace-${suffix}`,
      filePath: 'result.md',
      workspaceRevision: { id: `workspace-revision-${suffix}`, observedAt: now },
      contentRef: 'sha256:baseline-content',
      hash: { algorithm: 'sha256', value: 'baseline-hash' },
      sizeBytes: 12,
      source: 'user_selected',
      capturedAt: now
    };
    const revisionChain = {
      id: `chain-${suffix}`,
      dataEpoch: revisionBaseline.dataEpoch,
      sessionId,
      workspaceId: revisionBaseline.workspaceId,
      filePath: revisionBaseline.filePath,
      rootBaselineId: revisionBaseline.id,
      workspaceExpectedRevision: revisionBaseline.workspaceRevision,
      workspaceExpectedHash: { algorithm: 'sha256', value: 'revised-hash' },
      latestRevisionId: `revision-${suffix}`,
      latestIteration: 1,
      stateVersion: 2,
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    const revisionRun = {
      id: revisionChain.latestRevisionId,
      chainId: revisionChain.id,
      dataEpoch: revisionBaseline.dataEpoch,
      sessionId,
      baselineId: revisionBaseline.id,
      workspaceId: revisionBaseline.workspaceId,
      filePath: 'result.md',
      iteration: 1,
      status: 'awaiting_confirmation',
      baseKind: 'workspace_baseline',
      baseHash: revisionBaseline.hash,
      baseContentRef: revisionBaseline.contentRef,
      baseSizeBytes: revisionBaseline.sizeBytes,
      userDraftHash: revisionChain.workspaceExpectedHash,
      userDraftContentRef: 'sha256:revised-content',
      userDraftSizeBytes: 18,
      diffContentRef: 'sha256:revision-diff',
      diffHash: { algorithm: 'sha256', value: 'diff-hash' },
      diffSummary: { addedLines: 1, removedLines: 1, unchangedLines: 1, hunkCount: 1 },
      targetAgentIds: [agentId],
      contextSnapshotHash: `evidence-${suffix}`,
      agentResults: [],
      candidateContentRef: 'sha256:candidate-content',
      candidateHash: { algorithm: 'sha256', value: 'candidate-hash' },
      candidateSizeBytes: 20,
      confirmationId: `confirmation-${suffix}`,
      createdAt: now,
      updatedAt: now
    };
    const revisionDraft = {
      chainId: revisionChain.id,
      sourceRevisionId: revisionRun.id,
      sourceCandidateHash: revisionRun.candidateHash,
      contentRef: 'sha256:editor-draft',
      contentHash: { algorithm: 'sha256', value: 'draft-hash' },
      sizeBytes: 22,
      updatedBy: { type: 'user', id: 'local-user' },
      updatedAt: now
    };
    await store.writeCollection('fileRevisions', {
      schemaVersion: 2,
      baselines: [revisionBaseline],
      chains: [revisionChain],
      runs: [revisionRun],
      drafts: [revisionDraft]
    });
    await store.writeCollection('tasksBySession', {
      [sessionId]: [{ id: taskId, title: 'Projection Task', status: 'completed', assigneeId: agentId, createdAt: now, updatedAt: now }]
    });
    await store.writeCollection('sessions', [{ ...session, status: 'EXECUTING' }]);
    const writeback = {
      id: `writeback-${suffix}`,
      sessionId,
      taskId,
      invocationId: `invocation-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      providerKind: 'server_local',
      changeSet: {
        id: `changes-${suffix}`,
        baseRevision: revisionBaseline.workspaceRevision,
        changes: [{ operation: 'create', path: 'result.txt', content: 'done', encoding: 'utf-8' }],
        createdAt: now
      },
      status: 'conflicted',
      conflicts: [],
      createdAt: now,
      updatedAt: now
    };
    await store.writeCollection('workspaceWritebacks', [writeback]);
    await store.appendEvent({
      id: eventId,
      sessionId,
      type: 'agent_message',
      content: 'persisted',
      actor: { type: 'agent', id: agentId },
      toAgentIds: [],
      metadata: { schemaVersion: '0.1', payload: {} },
      createdAt: now
    });
    await store.markEventPublished(eventId);

    const projections = await pool.query<{
      skill_bindings: number; tool_bindings: number; knowledge_bindings: number;
      context_requests: number; status_history: number; progress: number; outbox_published: number; tool_versions: number;
      file_revision_records: number;
    }>(`
      select
        (select count(*)::int from agent_cluster.agent_skill_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) skill_bindings,
        (select count(*)::int from agent_cluster.agent_tool_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) tool_bindings,
        (select count(*)::int from agent_cluster.agent_knowledge_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) knowledge_bindings,
        (select count(*)::int from agent_cluster.supplemental_context_requests where external_id=$2) context_requests,
        (select count(*)::int from agent_cluster.session_status_history h join agent_cluster.sessions s on s.id=h.session_id where s.external_id=$3) status_history,
        (select count(*)::int from agent_cluster.session_progress p join agent_cluster.sessions s on s.id=p.session_id where s.external_id=$3) progress,
        (select count(*)::int from agent_cluster.event_outbox where external_id=$4 and status='published') outbox_published,
        (select count(*)::int from agent_cluster.tool_versions tv join agent_cluster.tools t on t.id=tv.tool_id where t.tool_key=$5) tool_versions,
        (select count(*)::int from agent_cluster.file_revision_records f join agent_cluster.sessions s on s.id=f.session_id where s.external_id=$3 and f.deleted_at is null) file_revision_records
    `, [agentId, contextRequestId, sessionId, `outbox:${eventId}`, toolName]);
    assert.equal(projections.rows[0].skill_bindings, 1);
    assert.ok(projections.rows[0].tool_bindings >= 1);
    assert.equal(projections.rows[0].knowledge_bindings, 1);
    assert.equal(projections.rows[0].context_requests, 1);
    assert.equal(projections.rows[0].status_history, 2);
    assert.equal(projections.rows[0].progress, 1);
    assert.equal(projections.rows[0].outbox_published, 1);
    assert.equal(projections.rows[0].tool_versions, 2);
    assert.equal(projections.rows[0].file_revision_records, 4);

    const loaded = await store.loadState();
    const loadedFileRevisions = loaded.fileRevisions as {
      schemaVersion: number;
      baselines: typeof revisionBaseline[];
      chains: typeof revisionChain[];
      runs: typeof revisionRun[];
      drafts: typeof revisionDraft[];
    };
    assert.equal(loadedFileRevisions.schemaVersion, 2);
    assert.equal(loadedFileRevisions.baselines.find((item) => item.id === revisionBaseline.id)?.contentRef, revisionBaseline.contentRef);
    assert.equal(loadedFileRevisions.chains.find((item) => item.id === revisionChain.id)?.stateVersion, 2);
    assert.equal(loadedFileRevisions.runs.find((item) => item.id === revisionRun.id)?.status, 'awaiting_confirmation');
    assert.equal(loadedFileRevisions.drafts.find((item) => item.chainId === revisionChain.id)?.contentRef, revisionDraft.contentRef);
    const loadedWritebacks = loaded.workspaceWritebacks as typeof writeback[];
    assert.equal(loadedWritebacks.find((item) => item.id === writeback.id)?.status, 'conflicted');
    const loadedOutbox = loaded.eventOutbox as Array<{ id: string; status: string; attempts: number; publishedAt?: string }>;
    const publishedOutbox = loadedOutbox.find((item) => item.id === `outbox:${eventId}`);
    assert.equal(publishedOutbox?.status, 'published');
    assert.equal(publishedOutbox?.attempts, 1);
    assert.ok(publishedOutbox?.publishedAt);

    const applyingState = structuredClone(loadedFileRevisions);
    applyingState.chains[0] = { ...applyingState.chains[0], status: 'applying', stateVersion: 3 };
    applyingState.runs[0] = { ...applyingState.runs[0], status: 'applying' };
    const abandonedState = structuredClone(loadedFileRevisions);
    abandonedState.chains[0] = { ...abandonedState.chains[0], status: 'abandoned', stateVersion: 3 };
    abandonedState.runs[0] = { ...abandonedState.runs[0], status: 'abandoned' };
    const competingWrites = await Promise.allSettled([
      store.compareAndSetCollection('fileRevisions', loadedFileRevisions, applyingState),
      competingStore.compareAndSetCollection('fileRevisions', loadedFileRevisions, abandonedState)
    ]);
    assert.equal(competingWrites.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(competingWrites.filter((result) => result.status === 'rejected').length, 1);
    const afterCas = (await store.loadState()).fileRevisions as typeof loadedFileRevisions;
    assert.equal(afterCas.chains[0]?.stateVersion, 3);
    assert.ok(['applying', 'abandoned'].includes(afterCas.chains[0]?.status ?? ''));

    const unavailablePool = new Pool({ connectionString: databaseUrl });
    const unavailableStore = new RelationalStateStore(
      unavailablePool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    await unavailablePool.end();
    await assert.rejects(
      unavailableStore.compareAndSetCollection('fileRevisions', afterCas, loadedFileRevisions),
      /end|closed|connect/i
    );
  } finally {
    await competingPool.end();
    await pool.end();
    rmSync(contentRoot, { recursive: true, force: true });
  }
});

test('empty relational startup imports a legacy collection state exactly once', { skip: !databaseUrl }, async () => {
  const isolatedDatabase = `agent_cluster_legacy_${process.pid}_${Date.now()}`;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const tableName = `legacy_import_${process.pid}_${Date.now()}`;
  const setupPool = new Pool({ connectionString: databaseUrl });
  const now = new Date().toISOString();
  const sessionId = `legacy-session-${process.pid}-${Date.now()}`;
  try {
    await setupPool.query(`create database ${isolatedDatabase}`);
    const isolatedPool = new Pool({ connectionString: isolatedUrl.toString() });
    await isolatedPool.query(`create table ${tableName} (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
    await isolatedPool.query(`insert into ${tableName} (key,value) values ($1,$2),($3,$4),($5,$6)`, [
      'systemDataMetadata', JSON.stringify({ dataSchemaVersion: 3, dataEpoch: 'legacy-epoch', pipelineVersion: 'v2', cutoverAt: now, cutoverAuditId: 'legacy-cutover' }),
      'sessions', JSON.stringify([{ id: sessionId, title: 'Legacy session', status: 'USER_INPUT', ownerId: 'local-user', createdAt: now, updatedAt: now }]),
      'eventsBySession', JSON.stringify({ [sessionId]: [{ id: `legacy-event-${sessionId}`, sessionId, type: 'user_message', content: 'legacy', actor: { type: 'user', id: 'local-user' }, createdAt: now }] })
    ]);
    await isolatedPool.end();

    const persistence = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolatedUrl.toString(), postgresCollectionTable: tableName });
    await persistence.initialize();
    persistence.assertCurrentDataReady();
    assert.equal(persistence.getCollection<{ id: string }[]>('sessions', [])[0]?.id, sessionId);
    await persistence.onModuleDestroy();

    const verifyPool = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      const relation = await verifyPool.query(`select count(*)::int count from agent_cluster.sessions where external_id=$1`, [sessionId]);
      assert.equal(relation.rows[0].count, 1);
      const legacy = await verifyPool.query(`select count(*)::int count from ${tableName}`);
      assert.equal(legacy.rows[0].count, 3);
    } finally {
      await verifyPool.end();
    }
  } finally {
    await setupPool.query(`drop database if exists ${isolatedDatabase}`).catch(() => undefined);
    await setupPool.end().catch(() => undefined);
  }
});

test('PostgreSQL keeps one requirement ledger across instances and refuses a double-spent allowance', { skip: !databaseUrl }, async () => {
  // Isolated database: the shared fixture database still holds content references
  // from earlier cases whose content root has already been removed, which would
  // make a plain initialize() fail on unavailable content instead of on real state.
  const isolatedDatabase = `agent_cluster_wib_${process.pid}_${Date.now()}`;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const setupPool = new Pool({ connectionString: databaseUrl });
  const isolated = isolatedUrl.toString();
  const sessionId = `work-item-budget-${process.pid}-${Date.now()}`;
  const workItemId = `${sessionId}-item`;
  const now = new Date().toISOString();
  let first: PersistenceService | undefined;
  let second: PersistenceService | undefined;
  let third: PersistenceService | undefined;
  try {
    await setupPool.query(`create database ${isolatedDatabase}`);
    first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    third = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []),
      { id: sessionId, dataEpoch: first.currentDataEpoch(), title: 'Budget ledger', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now }
    ]);
    await second.initialize();

    const firstStore = new WorkItemBudgetStore(first, () => now);
    const secondStore = new WorkItemBudgetStore(second, () => now);
    // Two independent holders of the same requirement, issued before either settles.
    const [a, b] = await Promise.all([
      firstStore.reserve({ sessionId, workItemId, attemptId: 'attempt-a', operationId: 'op-a', category: 'execution', requestedTokens: 700, limitTokens: 1_000, now }),
      secondStore.reserve({ sessionId, workItemId, attemptId: 'attempt-b', operationId: 'op-b', category: 'consultation', requestedTokens: 700, limitTokens: 1_000, now })
    ]);
    assert.deepEqual([a.status, b.status].sort(), ['insufficient', 'reserved'], 'exactly one may take the remaining allowance');

    // Initialized only now: reading through an instance loaded before the write
    // would assert on a stale snapshot rather than on what was committed.
    await third.initialize();
    const reopened = new WorkItemBudgetStore(third, () => now);
    const ledger = reopened.get(sessionId, workItemId);
    assert.ok(ledger, 'the committed ledger must survive a fresh instance');
    assert.equal(ledger?.reservedTokens, 700);
    assert.equal(reopened.available(sessionId, workItemId), 300);

    const winner = a.status === 'reserved' ? 'attempt-a' : 'attempt-b';
    const settled = await reopened.settle({ sessionId, workItemId, attemptId: winner, outcome: { kind: 'reported', actualTokens: 640 }, now });
    assert.equal(settled.status, 'settled');
    const replay = await reopened.settle({ sessionId, workItemId, attemptId: winner, outcome: { kind: 'reported', actualTokens: 640 }, now });
    assert.equal(replay.status, 'idempotent', 'a replayed settlement must not double-charge');
    assert.equal(reopened.get(sessionId, workItemId)?.actualTokens, 640);

    const pool = new Pool({ connectionString: isolated });
    try {
      const row = await pool.query<{ reserved_tokens: string; actual_tokens: string; unknown_tokens: string }>(
        `select reserved_tokens,actual_tokens,unknown_tokens from agent_cluster.work_item_budgets where work_item_external_id=$1`,
        [workItemId]
      );
      assert.equal(row.rows.length, 1, 'the ledger must be persisted as a relational row, not only held in memory');
      assert.equal(Number(row.rows[0].reserved_tokens), 0, 'settlement must release the reservation row');
      assert.equal(Number(row.rows[0].actual_tokens), 640);
      assert.equal(Number(row.rows[0].unknown_tokens), 0);
    } finally {
      await pool.end();
    }
  } finally {
    await first?.onModuleDestroy().catch(() => undefined);
    await second?.onModuleDestroy().catch(() => undefined);
    await third?.onModuleDestroy().catch(() => undefined);
    await setupPool.query(`drop database if exists ${isolatedDatabase}`).catch(() => undefined);
    await setupPool.end().catch(() => undefined);
  }
});

test('PostgreSQL commits one summary checkpoint per coverage across instances and rejects a stale late summary', { skip: !databaseUrl }, async () => {
  const isolatedDatabase = `agent_cluster_sc_${process.pid}_${Date.now()}`;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const setupPool = new Pool({ connectionString: databaseUrl });
  const isolated = isolatedUrl.toString();
  const sessionId = `summary-checkpoint-${process.pid}-${Date.now()}`;
  const workItemId = `${sessionId}-item`;
  const now = new Date().toISOString();
  const summary = {
    goal: '实现导出', currentState: 'EXECUTING / task_execution', confirmedFacts: [], completed: [],
    decisions: ['[d-2] 导出只支持 Excel'], openQuestions: [], risks: [], nextSteps: []
  };
  const draft = (overrides: Partial<SummaryCheckpointDraft> = {}): SummaryCheckpointDraft => ({
    sessionId, workItemId, phase: 'task_execution', coveredEventSeq: 40, workItemRevision: 2,
    decisionLedgerRevision: 3, policyVersion: 'summary-checkpoint-v2', summaryMemory: summary,
    sourceEventIds: ['e-40'], sourceArtifactIds: [], sourceMemoryIds: [], sourceDecisionIds: ['d-2'], ...overrides
  });
  let first: PersistenceService | undefined;
  let second: PersistenceService | undefined;
  let third: PersistenceService | undefined;
  try {
    await setupPool.query(`create database ${isolatedDatabase}`);
    first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    third = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []),
      { id: sessionId, dataEpoch: first.currentDataEpoch(), title: 'Summary checkpoints', status: 'EXECUTING', ownerId: 'test',
        decisionLedgerRevision: 3, createdAt: now, updatedAt: now }
    ]);
    await first.setCollection('workItemsBySession', {
      [sessionId]: [{ id: workItemId, sessionId, title: 'Export', goal: 'Export Excel', status: 'active',
        revision: 2, createdFromEventId: 'e-1', inheritedDecisionIds: [], inheritedArtifactIds: [], createdAt: now, updatedAt: now }]
    });
    await second.initialize();

    const firstStore = new SummaryCheckpointStore(first, () => now);
    const secondStore = new SummaryCheckpointStore(second, () => now);
    // Two workers summarize the same coverage at the same time.
    const [a, b] = await Promise.all([firstStore.commit(draft()), secondStore.commit(draft())]);
    assert.deepEqual([a.status, b.status].sort(), ['committed', 'duplicate'], 'exactly one checkpoint per logical key');

    await third.initialize();
    const reopened = new SummaryCheckpointStore(third, () => now);
    const latest = reopened.latest(sessionId, workItemId);
    assert.equal(latest?.coveredEventSeq, 40, 'the committed checkpoint must be visible to a fresh instance');

    // A summary generated before the user changed the decision (older ledger
    // revision) arrives late: it must not become the effective checkpoint.
    const late = await reopened.commit(draft({
      coveredEventSeq: 45, decisionLedgerRevision: 2, summaryMemory: { ...summary, decisions: ['[d-1] 导出支持 CSV'] }
    }));
    assert.equal(late.status, 'rejected');
    assert.equal(late.status === 'rejected' && late.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');

    // A revision can advance before any replacement checkpoint is generated.
    await first.mutateCollections(['sessions', 'workItemsBySession'], (state) => {
      (state.sessions as Array<{ id: string; decisionLedgerRevision: number }>)
        .find((item) => item.id === sessionId)!.decisionLedgerRevision = 4;
      (state.workItemsBySession as Record<string, Array<{ revision: number }>>)[sessionId][0].revision = 3;
    });
    const noReplacementYet = await reopened.commit(draft({ coveredEventSeq: 50 }));
    assert.equal(noReplacementYet.status, 'rejected');
    assert.equal(noReplacementYet.status === 'rejected' && noReplacementYet.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');

    const event = (id: string) => ({ id, sessionId, type: 'user_message', content: id,
      toAgentIds: [], actor: { type: 'user', id: 'test' },
      metadata: { schemaVersion: '0.1', payload: {} }, createdAt: now });
    for (const id of ['page-1', 'page-2', 'page-3']) {
      assert.equal(await first.appendEvent(event(id) as Parameters<PersistenceService['appendEvent']>[0]), true);
    }
    const page1 = await third.readEventPage(sessionId, { limit: 2 });
    assert.deepEqual(page1?.items.map((item) => item.id), ['page-1', 'page-2']);
    assert.equal(page1?.hasMore, true);
    assert.equal(page1?.nextCursor, 'page-2');
    const page2 = await third.readEventPage(sessionId, { afterEventId: page1?.nextCursor, limit: 2 });
    assert.deepEqual(page2?.items.map((item) => item.id), ['page-3']);
    assert.equal(page2?.hasMore, false);
    const missing = await third.readEventPage('other-session', { limit: 2 });
    assert.deepEqual(missing?.items, [], 'another Session cannot see this history');

    const pool = new Pool({ connectionString: isolated });
    try {
      const rows = await pool.query<{ logical_key: string; covered_event_seq: string }>(
        `select logical_key,covered_event_seq from agent_cluster.summary_checkpoints where work_item_external_id=$1`,
        [workItemId]
      );
      assert.equal(rows.rows.length, 1, 'the rejected late summary must not be persisted');
      assert.equal(Number(rows.rows[0].covered_event_seq), 40);
    } finally {
      await pool.end();
    }
  } finally {
    await first?.onModuleDestroy().catch(() => undefined);
    await second?.onModuleDestroy().catch(() => undefined);
    await third?.onModuleDestroy().catch(() => undefined);
    await setupPool.query(`drop database if exists ${isolatedDatabase}`).catch(() => undefined);
    await setupPool.end().catch(() => undefined);
  }
});

test('PostgreSQL reserves one delegation per expert and revision across instances and refuses stale asks', { skip: !databaseUrl }, async () => {
  const isolatedDatabase = `agent_cluster_dr_${process.pid}_${Date.now()}`;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const setupPool = new Pool({ connectionString: databaseUrl });
  const isolated = isolatedUrl.toString();
  const sessionId = `discussion-${process.pid}-${Date.now()}`;
  const workItemId = `${sessionId}-item`;
  const now = new Date().toISOString();
  let first: PersistenceService | undefined;
  let second: PersistenceService | undefined;
  let third: PersistenceService | undefined;
  try {
    await setupPool.query(`create database ${isolatedDatabase}`);
    first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    third = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    await first.initialize();
    await first.setCollection('sessions', [...first.getCollection<unknown[]>('sessions', []),
      { id: sessionId, dataEpoch: first.currentDataEpoch(), title: 'Discussion', status: 'DISCUSSING', ownerId: 'test',
        decisionLedgerRevision: 0, createdAt: now, updatedAt: now }
    ]);
    await first.setCollection('workItemsBySession', {
      [sessionId]: [{ id: workItemId, sessionId, title: 'Storage', goal: 'Pick storage', status: 'active',
        revision: 3, createdFromEventId: 'e-1', inheritedDecisionIds: [], inheritedArtifactIds: [], createdAt: now, updatedAt: now }]
    });
    await second.initialize();

    const firstStore = new DiscussionStore(first, () => now);
    const secondStore = new DiscussionStore(second, () => now);
    const opened = await firstStore.open({
      sessionId, workItemId, requirementRevision: 3, generation: 0, coordinatorAgentId: 'coordinator',
      objective: 'Decide storage', exitCondition: 'owners assigned', roundLimit: 3, budgetTokens: 10_000
    });
    assert.equal(opened.status, 'opened');
    if (opened.status !== 'opened') return;
    // The second instance must see the run before it can reserve against it.
    await second.initialize();
    const ask = { targetAgentId: 'expert-1', origin: 'coordinator' as const, objective: 'Assess', expectedResult: 'Risks',
      budgetTokens: 2_000, requirementRevision: 3 };
    const [a, b] = await Promise.all([
      firstStore.reserveDelegation(opened.run.id, ask),
      secondStore.reserveDelegation(opened.run.id, ask)
    ]);
    // Two instances asking the same expert the same question on the same
    // revision: at most one delegation may exist afterwards.
    await third.initialize();
    const reopened = new DiscussionStore(third, () => now);
    const run = reopened.get(sessionId, opened.run.id);
    assert.ok(run, 'the run is visible to a fresh instance');
    const forExpert = (run?.delegations ?? []).filter((item) => item.targetAgentId === 'expert-1');
    assert.equal(forExpert.length, 1, `exactly one delegation persisted, got ${JSON.stringify([a.status, b.status])}`);

    const revised = await reopened.reviseRequirement(opened.run.id, { requirementRevision: 4 });
    assert.equal(revised.status, 'applied');
    const stale = await reopened.reserveDelegation(opened.run.id, ask);
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.status === 'rejected' && stale.code, 'DELEGATION_STALE_REVISION');

    const pool = new Pool({ connectionString: isolated });
    try {
      const rows = await pool.query<{ requirement_revision: string; revision: string; status: string }>(
        `select requirement_revision,revision,status from agent_cluster.discussion_runs where external_id=$1`,
        [opened.run.id]
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(Number(rows.rows[0].requirement_revision), 4, 'the projection follows the revised requirement');
      assert.equal(rows.rows[0].status, 'planning');
      const snapshot = await pool.query<{ count: string }>(
        `select jsonb_array_length(source_snapshot->'sourceRecord'->'delegations') count from agent_cluster.discussion_runs where external_id=$1`,
        [opened.run.id]
      );
      assert.equal(Number(snapshot.rows[0].count), 1, 'the refused stale ask left no delegation behind');
    } finally {
      await pool.end();
    }
  } finally {
    await first?.onModuleDestroy().catch(() => undefined);
    await second?.onModuleDestroy().catch(() => undefined);
    await third?.onModuleDestroy().catch(() => undefined);
    await setupPool.query(`drop database if exists ${isolatedDatabase}`).catch(() => undefined);
    await setupPool.end().catch(() => undefined);
  }
});
