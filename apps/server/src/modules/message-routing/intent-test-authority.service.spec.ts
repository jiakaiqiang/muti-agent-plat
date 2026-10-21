import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ChangeIntentTestAuthorityInput, IntentExecutionBinding, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { ContextManagementService, routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { IntentTestAuthorityService } from './intent-test-authority.service.js';
import { currentTestGrant, currentTestReportGrant, testRunnerBinding } from './intent-test-authority.js';
import { currentWorkspaceReadGrant, issueWorkspaceReadAuthority } from './intent-workspace-read.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'intent-test-authority-'));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath }); await persistence.initialize();
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  t.after(async () => { await persistence.onModuleDestroy(); const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(child.startsWith('intent-test-authority-') && !child.includes('..') && !isAbsolute(child)); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', revision: 1,
    title: 'Tests', originalInput: '只跑测试，不修改源码', status: 'PAUSED', intentContractVersion: 'intent-understanding-v1',
    tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    workingDirectory: { id: 'workspace', kind: 'server_local', path: directory, name: 'fixture', selectedAt: '2026-10-19T00:00:00Z' },
    workspaceContext: { binding: { workspaceId: 'workspace', providerKind: 'server_local', displayName: 'fixture',
      capabilities: { read: true, write: false, command: false, test: true }, boundAt: '2026-10-19T00:00:00Z',
      boundRevision: { id: 'revision', observedAt: '2026-10-19T00:00:00Z' } } } as SessionDetail['workspaceContext'] };
  session.intentWorkspaceReadAuthority = issueWorkspaceReadAuthority(session, 'original');
  await persistence.setCollection('sessions', [session]); await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  const service = new IntentTestAuthorityService(persistence);
  const get = () => persistence.getCollection<SessionDetail[]>('sessions', [])[0];
  const request = (overrides: Partial<ChangeIntentTestAuthorityInput> = {}): ChangeIntentTestAuthorityInput => ({ action: 'grant', script: 'test',
    dataEpoch: 'epoch', expectedBindingHash: testRunnerBinding(get(), 'test')!.bindingHash, expectedGrantRevision: get().intentTestAuthority?.grant.revision ?? 0,
    idempotencyKey: 'grant', ...overrides });
  const initialOutbox = persistence.getCollection('eventOutbox', []);
  return { persistence, session, service, get, request, filePath, initialOutbox };
}

test('test grants are independent of read, command and source permissions and bind the exact image/script/workspace', async t => {
  const f = await fixture(t), before = f.service.view(f.get());
  assert.equal(before.enabled, false); assert.equal(before.availableBindings.length, 3);
  assert.ok(currentWorkspaceReadGrant(f.get())); assert.equal(currentTestGrant(f.get()), undefined);
  const read = structuredClone(f.get().intentWorkspaceReadAuthority);
  const result = await f.service.change('session', 'user', f.request());
  assert.equal(result.enabled, true); assert.equal(result.authority?.grant.effect, 'run_tests');
  assert.equal(result.authority?.grant.resource.refId, result.authority?.binding.resourceId);
  assert.deepEqual(f.get().intentWorkspaceReadAuthority, read);
  assert.equal(f.get().workspaceContext!.binding.capabilities.command, false);
  assert.equal(f.get().workspaceContext!.binding.capabilities.write, false);
  assert.notEqual(testRunnerBinding(f.get(), 'test:unit')!.bindingHash, result.authority?.binding.bindingHash);
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'b'.repeat(64)}`;
  assert.equal(currentTestGrant(f.get()), undefined);
  assert.notEqual(testRunnerBinding(f.get(), 'test')!.bindingHash, result.authority?.binding.bindingHash);
});

test('report saving requires an explicit separate grant, can be removed without source authority, and cannot be resurrected by replay', async t => {
  const f = await fixture(t);
  await f.service.change('session', 'user', f.request()); assert.equal(currentTestReportGrant(f.get()), undefined);
  const request = f.request({ writeReport: true, idempotencyKey: 'allow-report' });
  await f.service.change('session', 'user', request);
  assert.equal(currentTestReportGrant(f.get())?.effect, 'write_artifact');
  assert.equal(currentTestReportGrant(f.get())?.resource.refId, `test-report:${testRunnerBinding(f.get(), 'test')!.bindingHash}`);
  assert.equal(f.get().workspaceContext!.binding.capabilities.write, false);
  await f.service.change('session', 'user', f.request({ writeReport: false, idempotencyKey: 'tests-only' }));
  assert.ok(currentTestGrant(f.get())); assert.equal(currentTestReportGrant(f.get()), undefined);
  await f.service.change('session', 'user', request); assert.equal(currentTestReportGrant(f.get()), undefined);
  await assert.rejects(f.service.change('session', 'user', { ...f.request(), writeReport: 'true' }), /INPUT_INVALID/);
});

test('idempotent replay repairs a lost post-commit executor notification without changing the grant again', async t => {
  const f = await fixture(t); let calls = 0;
  const service = new IntentTestAuthorityService(f.persistence, undefined, { authorityChanged: () => {
    if (++calls === 1) throw new Error('injected notification loss');
  } } as never);
  const request = f.request(); await assert.rejects(service.change('session', 'user', request), /notification loss/);
  assert.equal(f.get().intentTestAuthority?.grant.revision, 1);
  const replay = await service.change('session', 'user', request);
  assert.equal(replay.idempotentReplay, true); assert.equal(replay.authority?.grant.revision, 1); assert.equal(calls, 2);
});

test('concurrent grant/revoke choices use CAS, and replay returns current authority instead of resurrecting a grant', async t => {
  const f = await fixture(t), request = f.request();
  const replay = await Promise.all([f.service.change('session', 'user', request), f.service.change('session', 'user', request)]);
  assert.deepEqual(replay.map(row => row.idempotentReplay).sort(), [false, true]);
  const competing = [f.request({ action: 'revoke', idempotencyKey: 'revoke' }), f.request({ script: 'test:unit',
    expectedBindingHash: testRunnerBinding(f.get(), 'test:unit')!.bindingHash, idempotencyKey: 'unit' })];
  const outcomes = await Promise.allSettled(competing.map(body => f.service.change('session', 'user', body)));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.get().intentTestAuthority?.grant.revision, 2);
  const old = await f.service.change('session', 'user', request);
  assert.equal(old.idempotentReplay, true); assert.equal(old.authority?.grant.revision, 2);
  const events = f.persistence.getCollection<Record<string, Array<{ id: string; type: string }>>>('eventsBySession', {}).session;
  assert.equal(events.filter(event => event.type === 'intent_test_authority_changed').length, 2);
  assert.equal(f.persistence.getCollection<Array<unknown>>('eventOutbox', []).length, f.initialOutbox.length + 2);
  await assert.rejects(f.service.change('session', 'user', { ...request, action: 'revoke' }), /IDEMPOTENCY_CONFLICT/);
});

test('malformed, forged, stale and cross-owner test authority requests cannot change permission', async t => {
  const f = await fixture(t), request = f.request();
  for (const override of [{ script: 'deploy' }, { script: 'test && delete' }, { imageId: 'model-image' }, { grant: {} },
    { safeToApply: true }, { expectedGrantRevision: -1 }, { expectedGrantRevision: 0.5 }, { command: 'npm run test' }]) {
    await assert.rejects(f.service.change('session', 'user', { ...request, ...override }), /INPUT_INVALID/);
  }
  await assert.rejects(f.service.change('session', 'another-user', request), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.service.change('session', 'user', { ...request, dataEpoch: 'other' }), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.service.change('session', 'user', { ...request, expectedBindingHash: 'stale' }), /REVISION_CONFLICT/);
  assert.equal(f.get().intentTestAuthority, undefined); assert.deepEqual(f.persistence.getCollection('eventOutbox', []), f.initialOutbox);
});

test('revoke remains possible after runner configuration disappears and binding changes never grant implicitly', async t => {
  const f = await fixture(t); const granted = await f.service.change('session', 'user', f.request());
  delete process.env.INTENT_ISOLATED_TEST_IMAGE;
  assert.equal(f.service.view(f.get()).availableBindings.length, 0); assert.equal(f.service.view(f.get()).enabled, false);
  const revoke = { action: 'revoke' as const, script: 'test' as const, dataEpoch: 'epoch', expectedBindingHash: granted.authority!.binding.bindingHash,
    expectedGrantRevision: 1, idempotencyKey: 'revoke' };
  const result = await f.service.change('session', 'user', revoke);
  assert.equal(result.enabled, false); assert.ok(result.authority?.grant.revokedAt);
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'a'.repeat(64)}`;
  assert.equal(f.service.view(f.get()).enabled, false);
  await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].workingDirectory!.selectedAt = 'new-selection'; });
  await assert.rejects(f.service.change('session', 'user', { ...revoke, action: 'grant', expectedGrantRevision: 2, idempotencyKey: 'new' }), /REVISION_CONFLICT/);
});

test('grant, session revision, event and outbox roll back together on a File write failure and survive restart', async t => {
  const f = await fixture(t), request = f.request(), revision = f.get().revision;
  const write = (f.persistence as any).writeFileState; (f.persistence as any).writeFileState = () => { throw new Error('injected write failure'); };
  await assert.rejects(f.service.change('session', 'user', request), /injected write/);
  (f.persistence as any).writeFileState = write;
  assert.equal(f.get().revision, revision); assert.equal(f.get().intentTestAuthority, undefined);
  assert.deepEqual(f.persistence.getCollection('eventOutbox', []), f.initialOutbox);
  await f.service.change('session', 'user', request);
  const restarted = new PersistenceService({ enabled: true, backend: 'file', filePath: f.filePath }); await restarted.initialize();
  try { const replay = await new IntentTestAuthorityService(restarted).change('session', 'user', request);
    assert.equal(replay.idempotentReplay, true); assert.equal(replay.enabled, true); assert.equal(replay.authority?.grant.revision, 1);
  } finally { await restarted.onModuleDestroy(); }
});

test('bounded intent snapshots expose server runner candidates and configuration changes invalidate the fingerprint', async t => {
  const f = await fixture(t); await f.service.change('session', 'user', f.request());
  const context = new ContextManagementService(f.persistence), session = f.get();
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'message', currentMessage: session.originalInput, latestEventSeq: 0 });
  assert.equal(snapshot.effectAuthority?.testRunnerBindings.length, 3);
  assert.deepEqual(snapshot.effectAuthority?.grants.map(grant => grant.effect).sort(), ['read_workspace', 'run_tests']);
  assert.equal(snapshot.effectAuthority?.grants.find(grant => grant.effect === 'run_tests')?.sourceEventId, session.intentTestAuthority!.grant.sourceEventId);
  const before = routingBusinessFingerprint(session, [], [], []);
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'b'.repeat(64)}`;
  assert.notEqual(routingBusinessFingerprint(session, [], [], []), before);
});

test('execution guard rejects revoked, reissued or reconfigured test authority even when an old revision remains validated', async t => {
  const f = await fixture(t); await f.service.change('session', 'user', f.request());
  const original = structuredClone(f.get().intentTestAuthority!);
  const binding: IntentExecutionBinding = { routingId: 'route', intentRevision: 1, requirementRevision: 1, executionEpoch: 1,
    sessionGeneration: 1, decisionSetHash: 'none', effectScopeHash: 'scope' };
  // Synthetic validated revision isolates the final execution guard; it is not an end-to-end runnable plan.
  const draft = (): PersistedState => ({ sessions: [f.get()], sessionLifecyclesBySession: { session: { state: 'active', generation: 1 } },
    intentRoutingRecordsBySession: { session: [{ id: 'route', effectiveIntentRevision: 1, executionEpoch: 1 }] },
    intentRouteRevisionsBySession: { session: [{ routingId: 'route', intentRevision: 1, dataEpoch: 'epoch', authorizationState: 'validated',
      authorityGrants: [original.grant], validatedPlan: { outcome: 'applicable', steps: [{ target: { workItemId: null }, executionBinding: binding,
        effectScope: { effects: [{ kind: 'run_tests', target: original.grant.resource }], grantIds: [original.grant.id], prohibitions: [], scopeHash: 'scope' } }] } }] } });
  const input = { sessionId: 'session', dataEpoch: 'epoch', executionBinding: binding };
  assert.doesNotThrow(() => assertIntentExecutionCurrent(draft(), input));
  await f.service.change('session', 'user', f.request({ action: 'revoke', idempotencyKey: 'revoke' }));
  assert.throws(() => assertIntentExecutionCurrent(draft(), input), /TEST_AUTHORITY_STALE/);
  await f.service.change('session', 'user', f.request({ idempotencyKey: 'again' }));
  assert.throws(() => assertIntentExecutionCurrent(draft(), input), /TEST_AUTHORITY_STALE/);
  process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => assertIntentExecutionCurrent(draft(), input), /TEST_AUTHORITY_STALE/);
});
