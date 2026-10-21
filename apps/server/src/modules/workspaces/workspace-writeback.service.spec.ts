import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDetail, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { WorkspaceWritebackService } from './workspace-writeback.service.js';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';

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

function memoryTransaction(collections: Map<string, unknown>) {
  return async (_keys: string[], mutate: (draft: Record<string, unknown>) => unknown) => {
    const draft = structuredClone(Object.fromEntries(collections));
    const result = mutate(draft);
    for (const [key, value] of Object.entries(draft)) collections.set(key, structuredClone(value));
    return result;
  };
}

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
      mutateCollections: memoryTransaction(collections),
      setCollection: async (key: string, value: unknown) => { collections.set(key, structuredClone(value)); return true; }
    } as never,
    {
      resolve: () => ({
        statFile: async ({ path }: { path: string }) => ({ path, kind: 'file', size: 7,
          hash: { algorithm: 'sha256', value: createHash('sha256').update('current').digest('hex') } }),
        readFile: async ({ path }: { path: string }) => ({ path, content: 'current',
          encoding: 'utf-8', byteLength: 7, truncated: false, revision,
          hash: { algorithm: 'sha256', value: createHash('sha256').update('current').digest('hex') } }),
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
  await assert.rejects(service.clearSessionDrafts(session.id), /WORKSPACE_WRITEBACK_ACTIVE/);
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
      mutateCollections: memoryTransaction(collections),
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

test('an interrupted confirmed conflict keeps its editor draft and can be applied after restart', async () => {
  const currentHash = createHash('sha256').update('current').digest('hex');
  const persisted = [{
    id: 'writeback-interrupted-conflict', sessionId: session.id,
    invocationId: 'invocation-interrupted-conflict', workspaceId: session.workspaceId,
    providerKind: 'server_local', changeSet, status: 'applying',
    resolution: 'apply_conflict', conflicts: [],
    conflictObservedHashes: { 'result.txt': currentHash },
    conflictView: {
      id: 'writeback-interrupted-conflict', sessionId: session.id, deliveryRound: 0,
      source: 'workspace_writeback', targetOperation: 'writeback', version: 2,
      files: [{ fileId: 'file-result', path: 'result.txt', kind: 'text',
        status: 'confirmed', version: 2, oursContent: 'done',
        theirsContent: 'current', resultContent: 'resolved' }],
      createdAt: revision.observedAt, updatedAt: revision.observedAt
    },
    createdAt: revision.observedAt, updatedAt: revision.observedAt
  }];
  const applied: WorkspaceChangeSet[] = [];
  const { service } = fixture(async (input) => {
    applied.push(input);
    return { ok: true, changeSetId: input.id, revision, appliedCount: input.changes.length };
  }, persisted);
  const record = service.list(session.id)[0]!;
  assert.equal(record.status, 'failed');
  assert.equal(record.hasConflictDraft, true);
  assert.equal('conflictView' in record, false);
  assert.equal(service.hasConflict(session.id, record.id), true);
  assert.equal(service.conflictView(session.id, record.id).files[0]?.resultContent, 'resolved');
  const result = await service.resolve(session, record.id, {
    action: 'apply_conflict', expectedConflictVersion: 2
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.hasConflictDraft, false);
  assert.equal(applied[0]?.changes[0]?.operation, 'update');
  assert.equal(applied[0]?.changes[0]?.operation === 'update'
    ? applied[0].changes[0].content : undefined, 'resolved');
});

test('legacy conflicted writeback without an editor snapshot becomes retryable on restart', () => {
  const persisted = [{
    id: 'writeback-legacy-conflict', sessionId: session.id, invocationId: 'invocation-legacy',
    workspaceId: session.workspaceId, providerKind: 'server_local', changeSet,
    status: 'conflicted', conflicts: [], createdAt: revision.observedAt, updatedAt: revision.observedAt
  }];
  const { service } = fixture(async () => { throw new Error('not called'); }, persisted);
  assert.equal(service.list(session.id)[0]?.status, 'failed');
  assert.match(service.list(session.id)[0]?.error ?? '', /Retry merge/);
});

test('soft deletion removes only the selected Session conflict draft', async () => {
  const view = { id: 'writeback-draft', sessionId: session.id, deliveryRound: 0,
    source: 'workspace_writeback', targetOperation: 'writeback', version: 2,
    files: [{ fileId: 'file-draft', path: 'result.txt', kind: 'text', status: 'draft',
      version: 2, resultContent: 'private draft' }],
    createdAt: revision.observedAt, updatedAt: revision.observedAt };
  const records = [session.id, 'other-session'].map((sessionId, index) => ({
    id: index === 0 ? 'writeback-draft' : 'other-draft', sessionId,
    invocationId: `invocation-${index}`, workspaceId: session.workspaceId,
    providerKind: 'server_local', changeSet, status: 'conflicted', conflicts: [],
    conflictView: { ...view, id: index === 0 ? 'writeback-draft' : 'other-draft', sessionId },
    conflictObservedHashes: { 'result.txt': 'abc' },
    createdAt: revision.observedAt, updatedAt: revision.observedAt
  }));
  const { service, collections } = fixture(async () => { throw new Error('not called'); }, records);
  await service.clearSessionDrafts(session.id);
  assert.equal(service.list(session.id)[0]?.status, 'abandoned');
  const stored = collections.get('workspaceWritebacks') as Array<{ sessionId: string; conflictView?: unknown }>;
  assert.equal(stored.find((record) => record.sessionId === session.id)?.conflictView, undefined);
  assert.ok(stored.find((record) => record.sessionId === 'other-session')?.conflictView);
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

test('workspace conflict drafts survive restart and apply only the confirmed result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-conflict-'));
  try {
    await writeFile(join(root, 'result.txt'), 'workspace\n');
    const provider = new ServerLocalWorkspaceProvider(root);
    const collections = new Map<string, unknown>();
    const persistence = {
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      mutateCollections: memoryTransaction(collections),
      setCollection: async (key: string, value: unknown) => {
        collections.set(key, structuredClone(value)); return true;
      }
    } as never;
    const providers = { resolve: () => provider } as never;
    const makeService = () => new WorkspaceWritebackService(persistence, providers);
    const changeSetWithConflict: WorkspaceChangeSet = {
      ...changeSet,
      id: 'changes-three-way-conflict',
      changes: [{ operation: 'update', path: 'result.txt', content: 'session\n',
        encoding: 'utf-8', expectedHash: {
          algorithm: 'sha256', value: createHash('sha256').update('base\n').digest('hex')
        }, baseContent: 'base\n' }]
    };
    const first = makeService();
    const record = await first.enqueue({ session, invocationId: 'invocation-three-way-conflict',
      execution: { mode: 'staging_copy', baseRevision: revision,
        changeSet: changeSetWithConflict, dirtyBaseline: false, requiresUserConfirmation: false } });
    assert.equal(record.status, 'conflicted');
    assert.equal('conflictView' in record, false);
    const initial = first.conflictView(session.id, record.id);
    assert.equal(initial.source, 'workspace_writeback');
    assert.equal(initial.files[0]?.oursContent, 'session\n');
    assert.equal(initial.files[0]?.theirsContent, 'workspace\n');
    await assert.rejects(first.resolve(session, record.id, {
      action: 'use_session', confirmationId: record.id
    }), /Use the conflict editor/);
    const saved = await first.saveConflictFile(session.id, record.id, initial.files[0]!.fileId, {
      expectedVersion: initial.version, resultContent: 'resolved\n', confirm: true
    });
    await assert.rejects(first.saveConflictFile(session.id, record.id, initial.files[0]!.fileId, {
      expectedVersion: initial.version, resultContent: 'stale\n', confirm: true
    }), /WORKSPACE_CONFLICT_VERSION_CONFLICT/);
    const restored = makeService();
    assert.equal(restored.conflictView(session.id, record.id).files[0]?.resultContent, 'resolved\n');
    const applied = await restored.resolve(session, record.id, {
      action: 'apply_conflict', expectedConflictVersion: saved.version
    });
    assert.equal(applied.status, 'applied');
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'resolved\n');
    assert.equal('conflictView' in restored.list(session.id)[0]!, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace conflict rejects applying a draft after the current file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-conflict-drift-'));
  try {
    await writeFile(join(root, 'result.txt'), 'workspace\n');
    const provider = new ServerLocalWorkspaceProvider(root);
    const collections = new Map<string, unknown>();
    const service = new WorkspaceWritebackService({
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      mutateCollections: memoryTransaction(collections),
      setCollection: async (key: string, value: unknown) => {
        collections.set(key, structuredClone(value)); return true;
      }
    } as never, { resolve: () => provider } as never);
    const conflicting: WorkspaceChangeSet = { ...changeSet, id: 'changes-drift', changes: [{
      operation: 'update', path: 'result.txt', content: 'session\n', encoding: 'utf-8',
      expectedHash: { algorithm: 'sha256', value: createHash('sha256').update('base\n').digest('hex') },
      baseContent: 'base\n'
    }] };
    const record = await service.enqueue({ session, invocationId: 'invocation-drift',
      execution: { mode: 'staging_copy', baseRevision: revision,
        changeSet: conflicting, dirtyBaseline: false, requiresUserConfirmation: false } });
    assert.equal(record.status, 'conflicted');
    const view = service.conflictView(session.id, record.id);
    const saved = await service.saveConflictFile(session.id, record.id, view.files[0]!.fileId, {
      expectedVersion: view.version, resultContent: 'resolved\n', confirm: true
    });
    await writeFile(join(root, 'result.txt'), 'new external change\n');
    await assert.rejects(service.resolve(session, record.id, {
      action: 'apply_conflict', expectedConflictVersion: saved.version
    }), /WORKSPACE_CONFLICT_SOURCE_CHANGED/);
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'new external change\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('typed delete conflict can keep the current workspace file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-delete-conflict-'));
  try {
    await writeFile(join(root, 'result.txt'), 'workspace\n');
    const provider = new ServerLocalWorkspaceProvider(root);
    const collections = new Map<string, unknown>();
    const service = new WorkspaceWritebackService({
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      mutateCollections: memoryTransaction(collections),
      setCollection: async (key: string, value: unknown) => {
        collections.set(key, structuredClone(value)); return true;
      }
    } as never, { resolve: () => provider } as never);
    const deletion: WorkspaceChangeSet = { ...changeSet, id: 'changes-delete-conflict', changes: [{
      operation: 'delete', path: 'result.txt',
      expectedHash: { algorithm: 'sha256', value: createHash('sha256').update('base\n').digest('hex') },
      baseContent: 'base\n'
    }] };
    const record = await service.enqueue({ session, invocationId: 'invocation-delete-conflict',
      execution: { mode: 'staging_copy', baseRevision: revision,
        changeSet: deletion, dirtyBaseline: false, requiresUserConfirmation: false } });
    assert.equal(record.status, 'conflicted');
    const view = service.conflictView(session.id, record.id);
    assert.equal(view.files[0]?.kind, 'deleted');
    const saved = await service.saveConflictFile(session.id, record.id, view.files[0]!.fileId, {
      expectedVersion: view.version, binaryChoice: 'theirs', confirm: true
    });
    const applied = await service.resolve(session, record.id, {
      action: 'apply_conflict', expectedConflictVersion: saved.version
    });
    assert.equal(applied.status, 'applied');
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'workspace\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('typed local rename conflict requires authorization for the resolved ChangeSet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-rename-conflict-'));
  try {
    await writeFile(join(root, 'old.txt'), 'workspace source\n');
    await writeFile(join(root, 'new.txt'), 'workspace target\n');
    const provider = new ServerLocalWorkspaceProvider(root);
    const collections = new Map<string, unknown>();
    const service = new WorkspaceWritebackService({
      getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
      mutateCollections: memoryTransaction(collections),
      setCollection: async (key: string, value: unknown) => {
        collections.set(key, structuredClone(value)); return true;
      }
    } as never, { resolve: () => provider } as never);
    const localSession = { ...session, workspaceContext: {
      binding: { providerKind: 'local_bridge' }
    } } as SessionDetail;
    const moved: WorkspaceChangeSet = { ...changeSet, id: 'changes-rename-conflict', changes: [{
      operation: 'move', fromPath: 'old.txt', toPath: 'new.txt',
      expectedHash: { algorithm: 'sha256', value: createHash('sha256').update('base source\n').digest('hex') }
    }] };
    const record = await service.enqueue({ session: localSession, invocationId: 'invocation-rename-conflict',
      execution: { mode: 'staging_copy', baseRevision: revision,
        changeSet: moved, dirtyBaseline: false, requiresUserConfirmation: false } });
    assert.equal(record.status, 'conflicted');
    const view = service.conflictView(session.id, record.id);
    assert.equal(view.files[0]?.kind, 'renamed');
    assert.equal(view.files[0]?.previousPath, 'old.txt');
    const saved = await service.saveConflictFile(session.id, record.id, view.files[0]!.fileId, {
      expectedVersion: view.version, binaryChoice: 'ours', confirm: true
    });
    await assert.rejects(service.resolve(localSession, record.id, {
      action: 'apply_conflict', expectedConflictVersion: saved.version
    }), /LOCAL_WRITEBACK_AUTHORIZATION_UNAVAILABLE/);
    let authorized: WorkspaceChangeSet | undefined;
    const applied = await service.resolve(localSession, record.id, {
      action: 'apply_conflict', expectedConflictVersion: saved.version
    }, async (resolved) => { authorized = resolved; });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(authorized?.changes.map((item) => item.operation), ['update', 'delete']);
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'workspace source\n');
    await assert.rejects(readFile(join(root, 'old.txt'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
