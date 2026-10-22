import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceWriteFixture } from './intent-source.test-support.js';
import { IntentSourceAuthorityStore } from './intent-source-authority.js';
import { assertIntentRecordMutation } from '../persistence/intent-record-invariants.js';

test('R10a authority uses persisted owner confirmation, not model effects or ordinary messages', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const authority = await h.store.loadLive(h.binding);
  assert.deepEqual(authority.files.map(file => file.path), ['src/login.ts']);
  assert.equal(authority.actorId, 'user'); assert.equal(authority.sourceEventId, 'source-request');
  assert.ok(authority.rootIdentity.dev); assert.ok(authority.rootIdentity.ino);
  await assert.rejects(h.store.issue({ sessionId: 'session', actorId: 'intruder', sourceEventId: 'source-request',
    confirmationId: 'source-confirmation', workItemId: 'work', expectedRevision: 1 }), /AUTHORITY_OWNER/);
  await assert.rejects(h.store.issue({ sessionId: 'session', actorId: 'user', sourceEventId: 'source-request',
    confirmationId: 'model-invented', workItemId: 'work', expectedRevision: 1 }), /CONFIRMATION_REQUIRED/);
});

test('R10a authority immutable manifest, revoked grant and apply receipts survive file reload', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const old: any = { sessions: h.persistence.getCollection('sessions', []) };
  const edited = structuredClone(old); edited.sessions[0].intentSourceAuthorities[0].files[0].path = 'src/other.ts';
  assert.throws(() => assertIntentRecordMutation(old, edited), /SOURCE_AUTHORITY_IMMUTABLE/);
  const dropped = structuredClone(old); dropped.sessions[0].intentSourceAuthorities = [];
  assert.throws(() => assertIntentRecordMutation(old, dropped), /SOURCE_AUTHORITY_IMMUTABLE/);
  await h.store.revoke({ sessionId: 'session', actorId: 'user', authorityId: h.authority.id, expectedRevision: 1 });
  await assert.rejects(new IntentSourceAuthorityStore(h.persistence).loadLive(h.binding), /SOURCE_AUTHORITY_REVOKED/);
  const after = { sessions: h.persistence.getCollection('sessions', []) };
  assert.throws(() => assertIntentRecordMutation(after, old), /SOURCE_AUTHORITY_IMMUTABLE/);
});

for (const outcome of ['applied', 'not_applied', 'unknown'] as const) test(`R10a revoke/applying mutual exclusion: ${outcome}`, async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  await h.candidates.prepare(h.plan); const candidate = await h.candidates.capture(h.plan, h.proposal);
  const claim = await h.store.beginApply(h.binding, { writebackId: 'writeback', attemptId: 'attempt' });
  await assert.rejects(h.store.revoke({ sessionId: 'session', actorId: 'user', authorityId: h.authority.id, expectedRevision: 1 }), /SOURCE_APPLY_BUSY/);
  await assert.rejects(new IntentSourceAuthorityStore(h.persistence).beginApply(h.binding,
    { writebackId: 'another', attemptId: 'attempt' }), /SOURCE_APPLY_BUSY/);
  await h.store.finishApply(claim, outcome);
  if (outcome === 'unknown') {
    await assert.rejects(h.store.revoke({ sessionId: 'session', actorId: 'user', authorityId: h.authority.id, expectedRevision: 1 }), /SOURCE_APPLY_BUSY/);
  } else if (outcome === 'applied') {
    await assert.rejects(h.store.beginApply(h.binding, { writebackId: 'writeback', attemptId: 'replay' }), /SOURCE_CANDIDATE_ALREADY_APPLIED/);
  } else {
    await h.store.revoke({ sessionId: 'session', actorId: 'user', authorityId: h.authority.id, expectedRevision: 1 });
  }
  assert.equal(candidate.changeSet.id, h.store.bindingForCandidate({ sessionId: 'session', taskId: 'original-task',
    invocationId: 'source-invocation', changeSetId: candidate.changeSet.id }) ? candidate.changeSet.id : 'missing');
});

for (const field of ['authorityHash', 'authorityRevision', 'workspaceBindingHash', 'sessionGeneration', 'taskId', 'operationId'] as const) {
  test(`R10a forged binding ${field} is refused`, async t => {
    const h = await sourceWriteFixture(); t.after(h.cleanup);
    await assert.rejects(h.store.loadLive({ ...h.binding, [field]: typeof h.binding[field] === 'number' ? 999 : 'forged' }), /INTENT_SOURCE_/);
  });
}

test('R10a symlink replacement and invalid UTF-8 are refused without mutating source', async t => {
  const h = await sourceWriteFixture(); t.after(h.cleanup);
  const original = await readFile(join(h.root, 'src/login.ts'));
  await writeFile(join(h.root, 'src/login.ts'), Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(h.candidates.prepare(h.plan), /SOURCE_UTF8_REQUIRED/);
  await writeFile(join(h.root, 'src/login.ts'), original);
  const outside = join(h.directory, 'outside.ts'); await writeFile(outside, 'outside');
  try { await symlink(outside, join(h.root, 'src/alias.ts')); }
  catch (error: any) { if (error.code === 'EPERM') return; throw error; }
  await h.persistence.mutateCollections(['eventsBySession'], draft => {
    const events: any = draft.eventsBySession;
    events.session[1].metadata.payload.sourceAuthorization.paths = ['src/alias.ts'];
    events.session[1].metadata.payload.confirmationId = 'alias-confirmation';
  });
  await assert.rejects(h.store.issue({ sessionId: 'session', actorId: 'user', sourceEventId: 'source-request',
    confirmationId: 'alias-confirmation', workItemId: 'work', expectedRevision: 1 }), /SOURCE_PATH_LINK/);
  assert.deepEqual(await readFile(join(h.root, 'src/login.ts')), original);
});
