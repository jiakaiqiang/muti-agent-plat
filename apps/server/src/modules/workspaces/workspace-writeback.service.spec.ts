import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { SessionDetail, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { WorkspaceWritebackService } from './workspace-writeback.service.js';

const revision: WorkspaceRevision = { id: 'revision-writeback', observedAt: '2026-07-30T00:00:00.000Z' };
const changeSet: WorkspaceChangeSet = {
  id: 'changes-writeback',
  baseRevision: revision,
  changes: [{ operation: 'create', path: 'result.txt', content: 'done', encoding: 'utf-8' }],
  createdAt: revision.observedAt
};
const session = {
  id: 'session-writeback',
  workspaceId: 'workspace-writeback',
  workspaceContext: { binding: { providerKind: 'server_local' } }
} as SessionDetail;

function fixture(
  apply: (input: WorkspaceChangeSet) => Promise<any>,
  persisted: unknown[] = [],
  lifecycles: Record<string, unknown> = {}
) {
  const collections = new Map<string, unknown>([
    ['workspaceWritebacks', persisted],
    ['sessionLifecyclesBySession', lifecycles]
  ]);
  const service = new WorkspaceWritebackService(
    {
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      setCollection: async (key: string, value: unknown) => { collections.set(key, structuredClone(value)); return true; }
    } as never,
    {
      resolve: () => ({
        statFile: async () => { throw new Error('not found'); },
        applyChangeSet: apply
      })
    } as never
  );
  return { service, collections };
}

test('workspace writeback persists and applies an isolated ChangeSet', async () => {
  const applied: WorkspaceChangeSet[] = [];
  const { service, collections } = fixture(async (input) => {
    applied.push(input);
    return { ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length };
  });
  const record = await service.enqueue({
    session,
    taskId: 'task-writeback',
    invocationId: 'invocation-writeback',
    execution: { mode: 'staging_copy', baseRevision: revision, changeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  });
  assert.equal(record.status, 'applied');
  assert.equal(applied.length, 1);
  assert.equal((collections.get('workspaceWritebacks') as any[])[0]?.status, 'applied');
});

test('duplicate concurrent enqueue waits for the active writeback instead of applying twice', async () => {
  let releaseApply!: () => void;
  const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
  let applyCount = 0;
  const { service } = fixture(async (input) => {
    applyCount += 1;
    await applyGate;
    return { ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length };
  });
  const input = {
    session,
    taskId: 'task-duplicate',
    invocationId: 'invocation-duplicate',
    execution: { mode: 'staging_copy' as const, baseRevision: revision, changeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  };

  const first = service.enqueue(input);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = service.enqueue(input);
  releaseApply();
  const [firstRecord, duplicateRecord] = await Promise.all([first, duplicate]);

  assert.equal(applyCount, 1);
  assert.equal(firstRecord.id, duplicateRecord.id);
  assert.equal(duplicateRecord.status, 'applied');
});

test('workspace writeback requires an exact confirmation id before forcing the Session version', async () => {
  const conflict = {
    code: 'WORKSPACE_MERGE_CONFLICT' as const,
    message: 'overlap',
    changeSetId: changeSet.id,
    operation: 'create' as const,
    path: 'result.txt',
    actualRevision: revision
  };
  const { service } = fixture(async (input) => ({
    ok: false, changeSetId: input.id, revision, conflicts: [conflict]
  }));
  const record = await service.enqueue({
    session,
    invocationId: 'invocation-conflict',
    execution: { mode: 'staging_copy', baseRevision: revision, changeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  });
  assert.equal(record.status, 'conflicted');
  await assert.rejects(
    service.resolve(session, record.id, { action: 'use_session', confirmationId: 'wrong' }),
    /current writeback id/i
  );
});

test('workspace writeback rejects replay after a record is already terminal', async () => {
  const { service } = fixture(async (input) => ({
    ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length
  }));
  const record = await service.enqueue({
    session,
    invocationId: 'invocation-terminal',
    execution: { mode: 'staging_copy', baseRevision: revision, changeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  });
  await assert.rejects(
    service.resolve(session, record.id, { action: 'use_session', confirmationId: record.id }),
    /cannot be resolved from status applied/i
  );
});

test('workspace writeback serializes competing resolution actions', async () => {
  const persisted = [{
    id: 'writeback-race',
    sessionId: session.id,
    invocationId: 'invocation-race',
    workspaceId: session.workspaceId,
    providerKind: 'server_local',
    changeSet,
    status: 'conflicted',
    conflicts: [],
    createdAt: revision.observedAt,
    updatedAt: revision.observedAt
  }];
  const { service } = fixture(async (input) => ({
    ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length
  }), persisted);
  const [abandoned, replay] = await Promise.allSettled([
    service.resolve(session, 'writeback-race', { action: 'keep_workspace' }),
    service.resolve(session, 'writeback-race', { action: 'use_session', confirmationId: 'writeback-race' })
  ]);
  assert.equal(abandoned.status, 'fulfilled');
  assert.equal(replay.status, 'rejected');
});

test('forcing a move replaces an existing destination without relying on rename overwrite behavior', async () => {
  const files = new Map([['old.txt', 'Session content'], ['new.txt', 'Workspace content']]);
  const applied: WorkspaceChangeSet[] = [];
  const hash = (content: string) => ({
    algorithm: 'sha256' as const,
    value: createHash('sha256').update(content).digest('hex')
  });
  const moved = {
    ...changeSet,
    id: 'changes-move',
    changes: [{ operation: 'move', fromPath: 'old.txt', toPath: 'new.txt', expectedHash: hash('old baseline') }]
  } satisfies WorkspaceChangeSet;
  const persisted = [{
    id: 'writeback-move',
    sessionId: session.id,
    invocationId: 'invocation-move',
    workspaceId: session.workspaceId,
    providerKind: 'server_local',
    changeSet: moved,
    status: 'conflicted',
    conflicts: [],
    createdAt: revision.observedAt,
    updatedAt: revision.observedAt
  }];
  const collections = new Map<string, unknown>([['workspaceWritebacks', persisted]]);
  const service = new WorkspaceWritebackService(
    {
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      setCollection: async (key: string, value: unknown) => { collections.set(key, structuredClone(value)); return true; }
    } as never,
    {
      resolve: () => ({
        statFile: async ({ path }: { path: string }) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return { path, kind: 'file', hash: hash(content) };
        },
        readFile: async ({ path }: { path: string }) => ({
          path,
          content: files.get(path)!,
          encoding: 'utf-8',
          byteLength: files.get(path)!.length,
          truncated: false,
          revision
        }),
        applyChangeSet: async (input: WorkspaceChangeSet) => {
          applied.push(input);
          return { ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length };
        }
      })
    } as never
  );

  const result = await service.resolve(session, 'writeback-move', {
    action: 'use_session',
    confirmationId: 'writeback-move'
  });

  assert.equal(result.status, 'applied');
  assert.deepEqual(applied[0]?.changes.map((item) => item.operation), ['update', 'delete']);
  assert.equal(applied[0]?.changes[0]?.operation === 'update' ? applied[0].changes[0].content : undefined, 'Session content');
});

test('workspace writeback recovers in-flight persisted records as retryable failures after restart', () => {
  const persisted = [{
    id: 'writeback-restart',
    sessionId: session.id,
    invocationId: 'invocation-restart',
    workspaceId: session.workspaceId,
    providerKind: 'server_local',
    changeSet,
    status: 'applying',
    conflicts: [],
    createdAt: revision.observedAt,
    updatedAt: revision.observedAt
  }];
  const { service } = fixture(async () => { throw new Error('not called'); }, persisted);
  const record = service.list(session.id)[0];
  assert.equal(record?.status, 'failed');
  assert.match(record?.error ?? '', /backend restart/i);
});

test('queued writeback from a closed generation never reaches the workspace provider', async () => {
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  let applyCount = 0;
  const activeLifecycle = {
    [session.id]: {
      contractVersion: 'main-agent-collaboration/v1', sessionId: session.id, dataEpoch: 'epoch-test',
      generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle'
    }
  };
  const { service, collections } = fixture(async (input) => {
    applyCount += 1;
    if (input.id === changeSet.id) {
      firstEntered();
      await firstGate;
    }
    return { ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length };
  }, [], activeLifecycle);

  const first = service.enqueue({
    session,
    invocationId: 'invocation-first-generation',
    execution: { mode: 'staging_copy', baseRevision: revision, changeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  });
  await entered;
  const queuedChangeSet = { ...changeSet, id: 'changes-queued-after-close' };
  const queued = service.enqueue({
    session,
    invocationId: 'invocation-queued-generation',
    execution: { mode: 'staging_copy', baseRevision: revision, changeSet: queuedChangeSet, dirtyBaseline: false, requiresUserConfirmation: false }
  });
  collections.set('sessionLifecyclesBySession', {
    [session.id]: { ...activeLifecycle[session.id], revision: 2, state: 'deleting', admission: 'closed' }
  });
  releaseFirst();

  const [firstResult, queuedResult] = await Promise.all([first, queued]);
  assert.equal(firstResult.status, 'applied');
  assert.equal(queuedResult.status, 'failed');
  assert.match(queuedResult.error ?? '', /SESSION_ADMISSION_CLOSED/);
  assert.equal(applyCount, 1);
});

test('a restored Session cannot resolve a conflicted writeback from an older generation', async () => {
  const persisted = [{
    id: 'writeback-old-generation', sessionId: session.id, sessionGeneration: 1,
    invocationId: 'invocation-old-generation', workspaceId: session.workspaceId,
    providerKind: 'server_local', changeSet, status: 'conflicted', conflicts: [],
    createdAt: revision.observedAt, updatedAt: revision.observedAt
  }];
  const { service } = fixture(async () => { throw new Error('must not apply'); }, persisted, {
    [session.id]: {
      contractVersion: 'main-agent-collaboration/v1', sessionId: session.id, dataEpoch: 'epoch-test',
      generation: 3, revision: 4, state: 'active', admission: 'open', stopStatus: 'confirmed'
    }
  });
  await assert.rejects(
    service.resolve(session, 'writeback-old-generation', {
      action: 'use_session', confirmationId: 'writeback-old-generation'
    }),
    /SESSION_ADMISSION_CLOSED/
  );
});
