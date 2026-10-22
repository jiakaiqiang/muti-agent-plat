import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceWriteFixture } from './intent-source.test-support.js';
import { assertIntentRecordMutation } from '../persistence/intent-record-invariants.js';
import { ContentReferenceCodec } from '../persistence/content-reference-codec.js';
import { LocalContentStore } from '../persistence/local-content-store.js';
import { RelationalStateStore } from '../persistence/relational/relational-state-store.js';

test('R10a captures server IDs/baseline/readset and task checkpoint atomically; capture never writes source', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const prepared = await h.candidates.prepare(h.plan), original = await readFile(join(h.root, 'src/login.ts'), 'utf8');
  assert.equal(prepared.files[0].content, original);
  const candidate = await h.candidates.capture(h.plan, h.proposal);
  assert.equal(candidate.changeSet.changes[0].operation, 'update');
  assert.deepEqual((candidate.changeSet.changes[0] as any).expectedHash, prepared.files[0].hash);
  assert.equal((candidate.changeSet.changes[0] as any).baseContent, original);
  const state: any = h.persistence.getCollection('sessions', []);
  const tasks: any = h.persistence.getCollection('tasksBySession', {});
  assert.equal(state[0].intentSourceCandidates[0].candidate.id, candidate.id);
  assert.equal(tasks.session[0].executionCheckpoint.candidateId, candidate.id);
  assert.equal(await readFile(join(h.root, 'src/login.ts'), 'utf8'), original);
  assert.deepEqual(await h.candidates.capture(h.plan, h.proposal), candidate);
  await assert.rejects(h.candidates.capture(h.plan, { ...h.proposal, updates: [{ path: 'src/login.ts', content: 'different' }] }), /CANDIDATE_PAYLOAD_CONFLICT/);
});

test('R10a model cannot forge IDs, operations, hashes, readset or workspace authority', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup); await h.candidates.prepare(h.plan);
  for (const forged of [{ ...h.proposal, id: 'model-id' }, { ...h.proposal, readSet: [] },
    { ...h.proposal, updates: [{ path: 'src/login.ts', content: 'x', expectedHash: { value: 'forged' } }] },
    { ...h.proposal, updates: [{ operation: 'delete', path: 'src/login.ts', content: '' }] }]) {
    await assert.rejects(h.candidates.capture(h.plan, forged), /SOURCE_PROPOSAL_INVALID/);
  }
  const tasks: any = h.persistence.getCollection('tasksBySession', {}); assert.equal(tasks.session[0].executionCheckpoint, undefined);
});

for (const path of ['../outside.ts', 'src/../src/login.ts', '/tmp/escape.ts', 'src/LOGIN.ts', 'src/login.ts:stream', 'src/new.ts']) {
  test(`R10a refuses out-of-manifest or aliased candidate path ${path}`, async t => {
    const h = await sourceWriteFixture(); t.after(h.cleanup); await h.candidates.prepare(h.plan);
    const before = await readFile(join(h.root, 'src/login.ts'));
    await assert.rejects(h.candidates.capture(h.plan, { ...h.proposal, updates: [{ path, content: 'unsafe' }] }), /SOURCE_(PATH|FILE)/);
    assert.deepEqual(await readFile(join(h.root, 'src/login.ts')), before);
  });
}

test('R10a concurrent edits cannot become a new baseline after the model returns', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const prepared = await h.candidates.prepare(h.plan);
  await writeFile(join(h.root, 'src/login.ts'), '// concurrent owner edit\n');
  const candidate = await h.candidates.capture(h.plan, h.proposal);
  assert.deepEqual((candidate.changeSet.changes[0] as any).expectedHash, prepared.files[0].hash);
  assert.equal((candidate.changeSet.changes[0] as any).baseContent, prepared.files[0].content);
  assert.equal(await readFile(join(h.root, 'src/login.ts'), 'utf8'), '// concurrent owner edit\n');
});

test('R10a prepared invocation missing capture or wrong ChangeSet cannot fall back to legacy writeback', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup); await h.candidates.prepare(h.plan);
  assert.throws(() => h.store.bindingForCandidate({ sessionId: 'session', invocationId: h.binding.invocationId,
    taskId: h.binding.taskId, changeSetId: 'forged' }), /SOURCE_CANDIDATE_REQUIRED/);
  const candidate = await h.candidates.capture(h.plan, h.proposal);
  assert.throws(() => h.store.bindingForCandidate({ sessionId: 'session', invocationId: h.binding.invocationId,
    taskId: h.binding.taskId, changeSetId: 'forged' }), /SOURCE_CANDIDATE_BINDING_MISMATCH/);
  assert.deepEqual(h.store.bindingForCandidate({ sessionId: 'session', invocationId: h.binding.invocationId,
    taskId: h.binding.taskId, changeSetId: candidate.changeSet.id }), h.binding);
});

test('R10a source snapshots/candidate receipts cannot be overwritten by stale Session projection', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup); await h.candidates.prepare(h.plan);
  const before: any = { sessions: h.persistence.getCollection('sessions', []) };
  const forged = structuredClone(before); forged.sessions[0].intentSourceCandidates[0].files[0].hash.value = 'forged';
  assert.throws(() => assertIntentRecordMutation(before, forged), /SOURCE_CANDIDATE_IMMUTABLE/);
  await h.candidates.capture(h.plan, h.proposal);
  assert.throws(() => assertIntentRecordMutation({ sessions: h.persistence.getCollection('sessions', []) }, before), /SOURCE_CANDIDATE_IMMUTABLE/);
});

for (const marker of ['sourceCandidateBinding', 'effectScope', 'expectedOutput', 'executionBinding'] as const) {
  test(`R10a source invocation with ${marker} cannot fall back when its candidate record is absent`, async t => {
    const h = await sourceWriteFixture(); t.after(h.cleanup);
    await h.persistence.mutateCollections(['runtimeInvocationsBySession', 'logicalOperationsBySession'], draft => {
      draft.runtimeInvocationsBySession = { session: [{ invocationId: h.binding.invocationId,
        [marker]: h.plan[marker] }] };
      // Isolate this marker: a missing operation projection must not hide the invocation evidence.
      draft.logicalOperationsBySession = {};
    });
    assert.throws(() => h.store.bindingForCandidate({ sessionId: 'session', invocationId: h.binding.invocationId,
      taskId: h.binding.taskId, changeSetId: 'untrusted' }), /SOURCE_CANDIDATE_REQUIRED/);
    assert.equal(await readFile(join(h.root, 'src/login.ts'), 'utf8'), h.base);
  });
}

test('R10a direct service calls enforce the shared candidate-only runtime and tool policy', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const forged = structuredClone(h.plan); forged.executionTarget.runtimeType = 'codex';
  await assert.rejects(h.candidates.prepare(forged), /SOURCE_CANDIDATE_INVOCATION_INVALID/);
  const withWriteTool = structuredClone(h.plan); withWriteTool.toolCatalog.tools = [{ name: 'write_file' } as any];
  await assert.rejects(h.candidates.prepare(withWriteTool), /INTENT_TOOL_SCOPE_MISMATCH/);
  assert.equal((h.persistence.getCollection<any[]>('sessions', [])[0]).intentSourceCandidates, undefined);
});

for (const revoked of [true, false]) test(`R10a workspace read authority is independent of source authority: revoked=${revoked}`, async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  await h.persistence.mutateCollections(['sessions'], draft => {
    const grant = (draft.sessions as any[])[0].intentWorkspaceReadAuthority.grant;
    if (revoked) grant.revokedAt = new Date().toISOString(); else grant.revision++;
  });
  await assert.rejects(h.candidates.prepare(h.plan), /WORKSPACE_READ_AUTHORITY_STALE/);
});

for (const mutation of ['active', 'deadline', 'paused', 'stopped', 'owner', 'admission', 'task'] as const) {
  test(`R10a candidate/tool guard rejects stale execution ownership: ${mutation}`, async t => {
    const h = await sourceWriteFixture(); t.after(h.cleanup);
    await h.persistence.mutateCollections(['logicalOperationsBySession', 'sessionLifecyclesBySession', 'tasksBySession'], draft => {
      const operation = (draft.logicalOperationsBySession as any).session[0];
      if (mutation === 'active') operation.activeInvocationId = 'another-invocation';
      if (mutation === 'deadline') operation.deadlineAt = new Date(0).toISOString();
      if (mutation === 'paused') operation.pauseRequested = true;
      if (mutation === 'stopped') operation.stopState = 'requested';
      if (mutation === 'owner') delete operation.ownerId;
      if (mutation === 'admission') (draft.sessionLifecyclesBySession as any).session.admission = 'closed';
      if (mutation === 'task') (draft.tasksBySession as any).session[0].status = 'completed';
    });
    await assert.rejects(h.candidates.assertLive(h.plan), /SOURCE_OPERATION_STALE/);
    assert.equal((h.persistence.getCollection<any[]>('sessions', [])[0]).intentSourceCandidates, undefined);
  });
}

test('R10a pre-call aggregate read size remains bounded after authorization', async t => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/file${i}.txt`, 'initial']));
  const h = await sourceWriteFixture({ files }); t.after(h.cleanup);
  for (const path of Object.keys(files)) await writeFile(join(h.root, path), 'x'.repeat(200_000));
  await assert.rejects(h.candidates.prepare(h.plan), /SOURCE_FILE_LIMIT/);
});

for (const field of ['actorId', 'dataEpoch', 'sessionGeneration', 'taskId', 'slot'] as const) {
  test(`R10a source candidate cannot borrow another input-budget decision: ${field}`, async t => {
    const h = await sourceWriteFixture(); t.after(h.cleanup);
    const forged = structuredClone(h.plan);
    (forged.inputBudgetPolicy as any)[field] = field === 'sessionGeneration' ? 9 : 'unrelated';
    await assert.rejects(h.candidates.prepare(forged), /SOURCE_BUDGET_BINDING_INVALID/);
    assert.equal((h.persistence.getCollection<any[]>('sessions', [])[0]).intentSourceCandidates, undefined);
  });
}

test('R10a replacement of an authorized root or file invalidates its immutable identity', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  await rename(join(h.root, 'src/login.ts'), join(h.root, 'src/original.ts'));
  await writeFile(join(h.root, 'src/login.ts'), h.base);
  await assert.rejects(h.store.loadLive(h.binding), /SOURCE_FILE_IDENTITY_STALE/);
  await rename(h.root, join(h.directory, 'old-workspace'));
  await mkdir(h.root);
  await assert.rejects(h.store.loadLive(h.binding), /SOURCE_ROOT_STALE/);
});

test('R10a relational Session JSON and content-reference projection preserve authority, baseline, candidate and apply claims', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  await h.candidates.prepare(h.plan); await h.candidates.capture(h.plan, h.proposal);
  const claim = await h.store.beginApply(h.binding, { writebackId: 'writeback', attemptId: 'attempt' });
  await h.store.finishApply(claim, 'unknown');
  const original = h.persistence.getCollection<any[]>('sessions', [])[0];
  const codec = new ContentReferenceCodec(new LocalContentStore({ rootDir: join(h.directory, 'content-store') }));
  let persisted: any;
  const client = { async query(sql: string, values?: unknown[]) {
    if (sql.startsWith('insert into agent_cluster.sessions ')) {
      const metadataIndex = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').indexOf('metadata');
      persisted = JSON.parse(values![metadataIndex] as string).sourceRecord;
      return { rows: [{ id: '1' }] };
    }
    if (sql.includes("select metadata->'sourceRecord' value from agent_cluster.sessions")) return { rows: [{ value: persisted }] };
    return { rows: [] };
  } };
  const store = new RelationalStateStore({} as never, codec) as any;
  await store.writeChangedRecords(client, { sessions: [] }, { sessions: [original] });
  assert.equal(typeof persisted.intentSourceCandidates[0].files[0].content, 'object');
  assert.ok(persisted.intentSourceCandidates[0].files[0].content.$contentRef);
  const restored = (await store.loadCollectionsWithClient(client, ['sessions'])).sessions[0];
  assert.deepEqual(restored, original);
  assert.equal(restored.intentSourceAuthorities[0].applyClaims[0].outcome, 'unknown');
  assert.doesNotThrow(() => assertIntentRecordMutation({ sessions: [original] }, { sessions: [restored] }));
});
