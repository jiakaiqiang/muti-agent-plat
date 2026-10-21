import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionDetail, WorkspaceChangeSet } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { IntentCorrectionService } from '../message-routing/intent-correction.service.js';
import { WorkspaceWritebackService } from './workspace-writeback.service.js';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'intent-writeback-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(root, 'state.json') });
  await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); await rm(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', title: '任务',
    originalInput: '修改结果', status: 'EXECUTING', tokenUsed: 0, participatingAgentIds: [], createdAt: now, updatedAt: now };
  await persistence.setCollection('sessions', [session]);
  const context = new ContextManagementService(persistence);
  const first = await context.ensureInitialWorkItem(session, 'first');
  const second = await context.createWorkItem({ session, sourceEventId: 'second', title: '第二任务', goal: '第二任务' });
  await persistence.setCollection('tasksBySession', { session: [
    { id: 'first-task', sessionId: 'session', workItemId: first.id },
    { id: 'second-task', sessionId: 'session', workItemId: second.id }
  ] });
  await writeFile(join(root, 'result.txt'), 'original');
  const provider = new ServerLocalWorkspaceProvider(root);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let applications = 0;
  const service = new WorkspaceWritebackService(persistence, { resolve: () => ({
    applyChangeSet: async (change: WorkspaceChangeSet) => {
      applications += 1; entered(); await gate; return provider.applyChangeSet(change);
    }
  }) } as never);
  const revision = { id: 'baseline', observedAt: now };
  const changes = (id: string, path: string): WorkspaceChangeSet => ({ id, baseRevision: revision, createdAt: now,
    changes: path === 'result.txt' ? [{ operation: 'update', path, content: 'old result', encoding: 'utf-8',
      expectedHash: { algorithm: 'sha256', value: createHash('sha256').update('original').digest('hex') } }] :
      [{ operation: 'create', path, content: 'unrelated', encoding: 'utf-8' }] });
  const enqueue = (taskId: string, invocationId: string, path: string) => service.enqueue({ session, taskId, invocationId,
    execution: { mode: 'staging_copy', changeSet: changes(invocationId, path), baseRevision: revision, dirtyBaseline: false, requiresUserConfirmation: false } });
  const corrections = new IntentCorrectionService(persistence);
  const accept = async (workItemId: string) => {
    const route = await context.createRoutingRecord({ session, sourceEventId: `route-${workItemId}`, idempotencyKey: workItemId, rolloutMode: 'enforce_all_current_epoch' });
    return corrections.accept('session', route.id, 'user', { contractVersion: 'intent-correction-v1', expectedRoutingRevision: 1,
      idempotencyKey: workItemId, instruction: '请按新要求处理', targetWorkItemId: workItemId, supersedesDecisionId: null, expectedDecisionRevision: null });
  };
  return { root, persistence, context, first, second, service, enqueue, accept, corrections, release, started, applications: () => applications };
}

test('a queued stale writeback never touches real files and does not block an unrelated active writeback', async t => {
  const f = await fixture(t);
  const first = f.enqueue('first-task', 'first-call', 'unrelated.txt');
  await f.started;
  const queued = f.enqueue('second-task', 'second-call', 'result.txt');
  // Wait until the queued receipt is durable before accepting the correction.
  while (!f.persistence.getCollection<Array<{ invocationId: string }>>('workspaceWritebacks', []).some(item => item.invocationId === 'second-call')) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const accepted = await f.accept(f.second.id);
  assert.deepEqual(accepted.correction.affectedExecutionIds, []);
  f.release();
  const [unrelated, obsolete] = await Promise.all([first, queued]);
  assert.equal(unrelated.status, 'applied');
  assert.equal(obsolete.status, 'failed');
  assert.match(obsolete.error ?? '', /INTENT_DISPATCH_HELD/);
  assert.equal(f.applications(), 1);
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), 'original');
  assert.equal(await readFile(join(f.root, 'unrelated.txt'), 'utf8'), 'unrelated');
});

test('a correction racing an admitted file write retains its hold and requires reconciliation', async t => {
  const f = await fixture(t);
  const writing = f.enqueue('second-task', 'active-write', 'result.txt');
  await f.started;
  const accepted = await f.accept(f.second.id);
  assert.deepEqual(accepted.correction.affectedExecutionIds, ['active-write']);
  await f.corrections.reconcileStop(accepted.correction);
  assert.equal(f.corrections.list('session', accepted.correction.routingId)[0].status, 'reconciliation_required');
  f.release();
  const result = await writing;
  assert.equal(result.status, 'applied');
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), 'old result');
  assert.equal(f.context.getWorkItem('session', f.second.id).dispatchHold?.correctionId, accepted.correction.id);
  assert.equal(f.corrections.history('session', accepted.correction.routingId).length, 1);
});

test('a superseded invocation cannot enqueue or replay its saved ChangeSet', async t => {
  const f = await fixture(t);
  await f.persistence.setCollection('runtimeInvocationsBySession', { session: [{ invocationId: 'late-call',
    sessionId: 'session', dataEpoch: 'epoch', workItemId: f.second.id, taskId: 'second-task', intentAdmission: { status: 'superseded' } }] });
  await assert.rejects(f.enqueue('second-task', 'late-call', 'result.txt'), /INTENT_EXECUTION_SUPERSEDED/);
  assert.equal(f.applications(), 0);
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), 'original');
});

test('a terminal write receipt cannot resurrect deleted Session data', async t => {
  const f = await fixture(t);
  const writing = f.enqueue('second-task', 'deleted-write', 'result.txt');
  await f.started;
  await f.persistence.deleteSessionData('session');
  f.release();
  const result = await writing;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'INTENT_EXECUTION_STALE');
  assert.deepEqual(f.persistence.getCollection('workspaceWritebacks', []), []);
  assert.deepEqual(f.service.list('session'), []);
});
