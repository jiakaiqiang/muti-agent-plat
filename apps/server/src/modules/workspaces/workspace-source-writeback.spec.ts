import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceChangeSet } from '@agent-cluster/shared';
import { sourceWriteFixture } from '../message-routing/intent-source.test-support.js';
import { WorkspaceWritebackService } from './workspace-writeback.service.js';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';

const path = 'src/login.ts';
const base = 'export function login(password: string) { return password; }\n';
const updated = 'export function login(password: string) { if (!password) return false; return password; }\n';
const digest = async (root: string) => createHash('sha256').update(await readFile(join(root, path))).digest('hex');

async function fixture(t: TestContext, guarded = false) {
  const f = await sourceWriteFixture({ files: { [path]: base }, prohibitions: guarded ? ['no_schema_change'] : [] });
  t.after(() => f.cleanup());
  await f.candidates.prepare(f.plan);
  const candidate = await f.candidates.capture(f.plan, {
    schemaVersion: '1.0', kind: 'intent_source_candidate', summary: '空密码校验', updates: [{ path, content: updated }]
  });
  await f.persistence.setCollection('runtimeInvocationsBySession', { [f.session.id]: [{
    invocationId: f.plan.invocationId, sessionId: f.session.id, taskId: f.plan.taskId, workItemId: f.plan.workItemId,
    dataEpoch: f.plan.dataEpoch, executionBinding: f.plan.executionBinding, effectScope: f.plan.effectScope,
    sourceCandidateBinding: f.plan.sourceCandidateBinding, executionCandidate: candidate
  }] });
  const service = new WorkspaceWritebackService(f.persistence, { resolve: () => f.provider } as never);
  const enqueue = (changeSet = candidate.changeSet, writer = service) => writer.enqueue({ session: f.session,
    taskId: f.plan.taskId, invocationId: f.plan.invocationId,
    execution: { mode: 'staging_copy', changeSet, baseRevision: candidate.baseRevision,
      dirtyBaseline: false, requiresUserConfirmation: false } });
  return { ...f, candidate, service, enqueue };
}

test('a captured source candidate changes real hashes only through the guarded writeback', async t => {
  const f = await fixture(t, true);
  const before = await digest(f.root);
  assert.equal(await readFile(join(f.root, path), 'utf8'), base);
  const result = await f.enqueue();
  assert.equal(result.status, 'applied', result.error);
  assert.notEqual(await digest(f.root), before);
  assert.equal(await readFile(join(f.root, path), 'utf8'), updated);
  const replay = await f.enqueue();
  assert.equal(replay.id, result.id);
  assert.equal(await readFile(join(f.root, path), 'utf8'), updated);
});

test('the writeback rejects a captured candidate with tampered bytes even when its id is unchanged', async t => {
  const f = await fixture(t);
  const before = await digest(f.root);
  const tampered = structuredClone(f.candidate.changeSet);
  const change = tampered.changes[0];
  if (change.operation !== 'update') throw new Error('fixture');
  change.content = 'export const password = "tampered";';
  await assert.rejects(f.enqueue(tampered), /INTENT_SOURCE_/);
  assert.equal(await digest(f.root), before);
  assert.deepEqual(f.service.list(f.session.id), []);
});

test('revocation between candidate capture and enqueue prevents any file write', async t => {
  const f = await fixture(t);
  const before = await digest(f.root);
  await f.store.revoke({ sessionId: f.session.id, actorId: 'user', id: f.authority.id,
    expectedRevision: f.authority.revision });
  await assert.rejects(f.enqueue(), /INTENT_SOURCE_/);
  assert.equal(await digest(f.root), before);
});

test('an admitted writeback and revoke exclude one another until actual application finishes', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class GatedProvider extends ServerLocalWorkspaceProvider {
    override async applyChangeSetGuarded(changeSet: WorkspaceChangeSet,
      guard: (rootPath: string, final: WorkspaceChangeSet) => Promise<void>) {
      entered(); await gate; return super.applyChangeSetGuarded(changeSet, guard);
    }
  }
  const writer = new WorkspaceWritebackService(f.persistence,
    { resolve: () => new GatedProvider(f.root, f.candidate.baseRevision) } as never);
  const pending = f.enqueue(f.candidate.changeSet, writer);
  try {
    await started;
    await assert.rejects(f.store.revoke({ sessionId: f.session.id, actorId: 'user', id: f.authority.id,
      expectedRevision: f.authority.revision }), /INTENT_SOURCE_.*(APPLY|BUSY|IN_FLIGHT)/);
    assert.equal(await readFile(join(f.root, path), 'utf8'), base);
  } finally { release(); }
  const result = await pending;
  assert.equal(result.status, 'applied', result.error);
});

test('conflict editing rejects invalid bytes before confirmation and leaves its version unchanged', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, path), base.replace('return password', 'return password.trim()'));
  const result = await f.enqueue();
  assert.equal(result.status, 'conflicted', result.error);
  const view = f.service.conflictView(f.session.id, result.id);
  const before = await digest(f.root);
  await assert.rejects(f.service.saveConflictFile(f.session.id, result.id, view.files[0].fileId, {
    expectedVersion: view.version, resultContent: 'binary\u0000content', confirm: true
  }), /INTENT_SOURCE_CHANGESET_REJECTED/);
  assert.deepEqual(f.service.conflictView(f.session.id, result.id), view);
  assert.equal(await digest(f.root), before);
  await f.store.revoke({ sessionId: f.session.id, actorId: 'user', id: f.authority.id,
    expectedRevision: f.authority.revision });
  await assert.rejects(f.service.saveConflictFile(f.session.id, result.id, view.files[0].fileId,
    { expectedVersion: view.version, resultContent: updated, confirm: true }), /INTENT_SOURCE_/);
  assert.deepEqual(f.service.conflictView(f.session.id, result.id), view);
  assert.equal(await digest(f.root), before);
});

test('force resolution after a known pre-write failure still refuses a revoked grant', async t => {
  const f = await fixture(t);
  class FailedProvider extends ServerLocalWorkspaceProvider {
    override async applyChangeSetGuarded(): Promise<never> {
      throw Object.assign(new Error('known pre-write rejection'), { workspaceApplyOutcome: 'not_applied' });
    }
  }
  const writer = new WorkspaceWritebackService(f.persistence,
    { resolve: () => new FailedProvider(f.root, f.candidate.baseRevision) } as never);
  const result = await f.enqueue(f.candidate.changeSet, writer);
  assert.equal(result.status, 'failed');
  const before = await digest(f.root);
  await f.store.revoke({ sessionId: f.session.id, actorId: 'user', id: f.authority.id,
    expectedRevision: f.authority.revision });
  await assert.rejects(writer.resolve(f.session, result.id,
    { action: 'use_session', confirmationId: result.id }), /INTENT_SOURCE_/);
  assert.equal(await digest(f.root), before);
});

test('conflict confirmation checks aggregate candidate bytes before freezing another file', async t => {
  const paths = Array.from({ length: 5 }, (_, index) => `src/file${index}.ts`);
  const f = await sourceWriteFixture({ files: Object.fromEntries(paths.map(path => [path, 'export const value = "base";\n'])) });
  t.after(() => f.cleanup());
  await f.candidates.prepare(f.plan);
  const candidate = await f.candidates.capture(f.plan, { schemaVersion: '1.0', kind: 'intent_source_candidate',
    summary: 'update files', updates: paths.map(path => ({ path, content: 'export const value = "candidate";\n' })) });
  await f.persistence.setCollection('runtimeInvocationsBySession', { [f.session.id]: [{
    invocationId: f.plan.invocationId, sessionId: f.session.id, taskId: f.plan.taskId, workItemId: f.plan.workItemId,
    dataEpoch: f.plan.dataEpoch, executionBinding: f.plan.executionBinding, effectScope: f.plan.effectScope,
    sourceCandidateBinding: f.plan.sourceCandidateBinding, executionCandidate: candidate
  }] });
  for (const path of paths) await writeFile(join(f.root, path), 'export const value = "current";\n');
  const writer = new WorkspaceWritebackService(f.persistence, { resolve: () => f.provider } as never);
  const record = await writer.enqueue({ session: f.session, taskId: f.plan.taskId, invocationId: f.plan.invocationId,
    execution: { mode: 'staging_copy', changeSet: candidate.changeSet, baseRevision: candidate.baseRevision,
      dirtyBaseline: false, requiresUserConfirmation: false } });
  assert.equal(record.status, 'conflicted');
  let view = writer.conflictView(f.session.id, record.id);
  assert.equal(view.files.length, 5);
  const content = 'x'.repeat(220 * 1024);
  for (const file of view.files.slice(0, 4)) {
    view = await writer.saveConflictFile(f.session.id, record.id, file.fileId,
      { expectedVersion: view.version, resultContent: content, confirm: true });
  }
  const before = structuredClone(view);
  await assert.rejects(writer.saveConflictFile(f.session.id, record.id, view.files[4].fileId,
    { expectedVersion: view.version, resultContent: content, confirm: true }), /INTENT_SOURCE_CHANGESET_REJECTED/);
  assert.deepEqual(writer.conflictView(f.session.id, record.id), before);
  for (const path of paths) assert.equal(await readFile(join(f.root, path), 'utf8'), 'export const value = "current";\n');
});
