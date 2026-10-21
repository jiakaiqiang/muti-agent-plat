import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import type { IntentPlanStepRecord, LogicalOperation, SessionDetail } from '@agent-cluster/shared';
import { issueTestAuthority } from '../message-routing/intent-test-authority.js';
import { decisionSetHash } from '../context-management/effective-decisions.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { LogicalOperationStore } from './logical-operation-store.js';
import { IsolatedTestRunStore } from './isolated-test-run-store.js';
import { IsolatedTestRunnerService } from './isolated-test-runner.service.js';
import { TestRunnerTool } from '../tools/builtin/test-runner.tool.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

const imageId = `sha256:${'a'.repeat(64)}`;
async function journalFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'isolated-journal-'));
  const file = join(root, 'state.json');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: file });
  await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('isolated-journal-') && !child.includes('..') && !isAbsolute(child)); await rm(root, { recursive: true, force: true }); });
  const session = { id: 'session', dataEpoch: 'epoch', status: 'RUNNING' };
  const lifecycle = { contractVersion: 'main-agent-collaboration/v1', sessionId: 'session', dataEpoch: 'epoch',
    generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'confirmed' };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('sessionLifecyclesBySession', { session: lifecycle });
  const operations = new LogicalOperationStore(persistence);
  await operations.begin({ id: 'operation', sessionId: 'session', dataEpoch: 'epoch', phase: 'task_execution' });
  await operations.reserve('session', 'operation', 'invocation');
  const identity = { sessionId: 'session', dataEpoch: 'epoch', operationId: 'operation', invocationId: 'invocation' };
  let now = Date.now();
  const store = new IsolatedTestRunStore(persistence, () => now);
  const reserve = () => store.reserve(identity, { imageId, script: 'test', ownerId: 'owner', deadlineAt: new Date(now + 120_000).toISOString() });
  const row = () => operations.list('session')[0].isolatedTestAttempts![0];
  return { root, file, persistence, operations, identity, session, lifecycle, store, reserve, row, advance: (ms: number) => { now += ms; } };
}

/** Synthetic committed plan isolates launch enforcement; it does not claim HTTP dispatch support. */
async function boundJournalFixture(t: TestContext, selectedImage = imageId) {
  const f = await journalFixture(t);
  const workspace = join(f.root, 'workspace'); await mkdir(workspace);
  const prior = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = selectedImage;
  t.after(() => { if (prior === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = prior; });
  const session = { ...f.session, intentContractVersion: 'intent-understanding-v1', workspaceId: 'workspace', ownerId: 'owner',
    workingDirectory: { id: 'workspace', kind: 'server_local', path: workspace, selectedAt: 'selected' },
    workspaceContext: { binding: { workspaceId: 'workspace', providerKind: 'server_local', boundAt: 'bound',
      capabilities: { read: true, write: false, command: false, test: true } } } } as SessionDetail;
  session.intentTestAuthority = issueTestAuthority(session, 'test:unit', 'grant-event', 1)!;
  const executionBinding = { routingId: 'route', intentRevision: 1, requirementRevision: 1, executionEpoch: 1, sessionGeneration: 1,
    decisionSetHash: decisionSetHash([]), effectScopeHash: 'scope' };
  const now = new Date().toISOString();
  const step = { stepId: 'step', segmentKey: 'segment', action: 'enqueue_follow_up',
    target: { workItemId: 'work', agentIds: [] }, executionBinding,
    effectScope: { effects: [{ kind: 'run_tests', target: session.intentTestAuthority.grant.resource }],
      grantIds: [session.intentTestAuthority.grant.id], prohibitions: [], scopeHash: 'scope' } };
  const record = { id: 'step', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route', intentRevision: 1, localKey: 'segment',
    status: 'running', step, reusedEffectIds: [], createdAt: now, updatedAt: now,
    processing: { ownerId: 'step-owner', invocationId: 'invocation', deadlineAt: new Date(Date.now() + 120000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), attemptsUsed: 1 } };
  await f.persistence.mutateCollections(['sessions', 'logicalOperationsBySession', 'workItemsBySession',
    'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession'], draft => {
    draft.sessions = [session];
    draft.workItemsBySession = { session: [{ id: 'work', sessionId: 'session', requirementRevision: 1, executionEpoch: 1, inheritedDecisionIds: [] }] };
    draft.intentRoutingRecordsBySession = { session: [{ id: 'route', sessionId: 'session', status: 'ROUTED', effectiveIntentRevision: 1, executionEpoch: 1 }] };
    draft.intentRouteRevisionsBySession = { session: [{ id: 'version', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route', intentRevision: 1,
      authorizationState: 'validated', authorityGrants: [session.intentTestAuthority!.grant], validatedPlan: { outcome: 'applicable', steps: [step] } }] };
    draft.intentPlanStepsBySession = { session: [record] };
    Object.assign((draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0],
      { workItemId: 'work', executionBinding, intentStepId: 'step', admissionClass: 'business' });
  });
  const request = { imageId: selectedImage, script: 'test:unit', workingDirectory: workspace, ownerId: 'owner', deadlineAt: new Date(Date.now() + 120000).toISOString() };
  return { ...f, root: workspace, boundSession: session, request, reserveBound: () => f.store.reserve(f.identity, request) };
}

test('bound journal pins runner authority and source root durably without requiring broad command permission', async t => {
  const f = await boundJournalFixture(t), attempt = await f.reserveBound();
  assert.deepEqual(attempt.authorityBinding, f.boundSession.intentTestAuthority!.binding);
  assert.equal(attempt.workingDirectory, f.root); assert.equal(attempt.script, 'test:unit');
  assert.equal(f.boundSession.workspaceContext!.binding.capabilities.command, false);
  const restored = new PersistenceService({ enabled: true, backend: 'file', filePath: f.file }); await restored.initialize();
  try { assert.deepEqual(restored.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {}).session[0].isolatedTestAttempts![0], attempt); }
  finally { await restored.onModuleDestroy(); }
});

test('wrong script, image or source root is rejected atomically before a container reservation', async t => {
  const f = await boundJournalFixture(t);
  for (const override of [{ script: 'test' }, { imageId: `sha256:${'b'.repeat(64)}` }, { workingDirectory: join(f.root, 'other') },
    { workingDirectory: '.' }, { workingDirectory: undefined }]) {
    await assert.rejects(f.store.reserve(f.identity, { ...f.request, ...override }), /RUNNER_BINDING_MISMATCH/);
    assert.equal(f.operations.list('session')[0].isolatedTestAttempts, undefined);
  }
  await f.reserveBound();
});

test('a queued, expired, foreign or invalidated plan cannot start an isolated test', async t => {
  for (const change of ['queued', 'invalidated', 'lease', 'deadline', 'invocation', 'step']) {
    const f = await boundJournalFixture(t);
    await f.persistence.mutateCollections(['intentPlanStepsBySession', 'logicalOperationsBySession'], draft => {
      const step = (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>).session[0];
      if (change === 'queued' || change === 'invalidated') step.status = change;
      if (change === 'lease') step.processing!.leaseExpiresAt = new Date(0).toISOString();
      if (change === 'deadline') step.processing!.deadlineAt = new Date(0).toISOString();
      if (change === 'invocation') step.processing!.invocationId = 'other';
      if (change === 'step') (draft.logicalOperationsBySession as Record<string, LogicalOperation[]>).session[0].intentStepId = 'other';
    });
    await assert.rejects(f.reserveBound(), /STEP_STALE/, change);
    assert.equal(f.operations.list('session')[0].isolatedTestAttempts, undefined);
  }
});

test('revoked, reissued and reconfigured authority fences active attempts while still allowing cleanup and audit', async t => {
  for (const change of ['revoke', 'reissue', 'image', 'workspace', 'step']) {
    const f = await boundJournalFixture(t); await f.reserveBound();
    await f.persistence.mutateCollections(['sessions', 'intentPlanStepsBySession'], draft => {
      const session = (draft.sessions as SessionDetail[])[0];
      if (change === 'revoke') session.intentTestAuthority!.grant.revokedAt = new Date().toISOString();
      if (change === 'reissue') session.intentTestAuthority = issueTestAuthority(session, 'test:unit', 'new-grant', 2);
      if (change === 'workspace') session.workingDirectory!.path = join(f.root, 'another');
      if (change === 'step') (draft.intentPlanStepsBySession as Record<string, IntentPlanStepRecord[]>).session[0].status = 'invalidated';
    });
    if (change === 'image') process.env.INTENT_ISOLATED_TEST_IMAGE = `sha256:${'b'.repeat(64)}`;
    await assert.rejects(f.store.update(f.identity, 'owner', { phase: 'running' }, true), /AUTHORITY_STALE|STEP_STALE/, change);
    assert.equal(f.row().phase, 'reserved');
    await f.store.update(f.identity, 'owner', { phase: 'finished', stopConfirmed: true, result: {
      stdout: 'audit only', stderr: '', exitCode: null, timedOut: false, aborted: true, outputTruncated: false } });
    assert.equal(f.row().result?.stdout, 'audit only');
  }
});

test('runner rejects a mismatched authorized script without contacting Docker', async t => {
  const f = await boundJournalFixture(t), runner = new IsolatedTestRunnerService(f.persistence); let commands = 0;
  (runner as any).command = async () => { commands++; throw new Error('unexpected Docker command'); };
  await assert.rejects(runner.run({ workingDirectory: f.root, script: 'test', timeoutMs: 1000, execution: f.identity }), /RUNNER_BINDING_MISMATCH/);
  assert.equal(commands, 0); assert.equal(f.operations.list('session')[0].isolatedTestAttempts, undefined);
});

test('revocation between container create and start prevents launch and still cleans the owned container', async t => {
  const f = await boundJournalFixture(t), runner = new IsolatedTestRunnerService(f.persistence);
  const commands: string[][] = []; let removed = false, guards = 0;
  (runner as any).command = async (args: string[]) => {
    commands.push(args); if (args[0] === 'rm') removed = true;
    return { code: removed && args[0] === 'inspect' ? 1 : 0, stdout: args[0] === 'info' ? 'daemon' : args[0] === 'image' ? 'linux|null' : `${f.row().identityHash}|${imageId}`,
      stderr: removed ? 'No such container' : '', timedOut: false, aborted: false, truncated: false };
  };
  const result = await runner.run({ workingDirectory: f.root, script: 'test:unit', timeoutMs: 10000, execution: f.identity,
    beforeLaunch: async () => { if (++guards === 2) await f.persistence.mutateCollections(['sessions'], draft => {
      (draft.sessions as SessionDetail[])[0].intentTestAuthority!.grant.revokedAt = new Date().toISOString();
    }); } });
  assert.equal(commands.filter(args => args[0] === 'create').length, 1);
  assert.equal(commands.filter(args => args[0] === 'start').length, 0); assert.equal(removed, true);
  assert.equal(result.isolation.stopConfirmed, true); assert.equal(f.row().phase, 'finished'); assert.equal(f.row().result?.exitCode, null);
});

test('real Docker runs only the authorized script and journals the exact binding without source writes', { skip: !process.env.INTENT_TEST_DOCKER_IMAGE, timeout: 45000 }, async t => {
  const f = await boundJournalFixture(t, process.env.INTENT_TEST_DOCKER_IMAGE), runner = new IsolatedTestRunnerService(f.persistence);
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(77)"', 'test:unit': 'node --test proof.cjs' } }));
  await writeFile(join(f.root, 'source.txt'), 'original');
  await writeFile(join(f.root, 'proof.cjs'), 'const {test}=require("node:test"),fs=require("node:fs"),assert=require("node:assert/strict");test("bound unit",()=>{assert.throws(()=>fs.writeFileSync("/input/source.txt","changed"));fs.writeFileSync("scratch.txt","allowed");});');
  const result = await runner.run({ workingDirectory: f.root, script: 'test:unit', timeoutMs: 25000, execution: f.identity });
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.exitCode, 0); assert.match(result.stdout, /# pass 1/);
  assert.deepEqual(f.row().authorityBinding, f.boundSession.intentTestAuthority!.binding);
  assert.equal(f.row().imageId, process.env.INTENT_TEST_DOCKER_IMAGE); assert.equal(f.row().script, 'test:unit');
  assert.equal(f.row().phase, 'finished'); assert.equal(f.row().stopConfirmed, true); assert.equal(f.row().cleanupRequired, false);
  assert.equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'original'); await assert.rejects(readFile(join(f.root, 'scratch.txt')));
});

test('real Docker revocation during execution aborts the owned container and preserves audit without retry', { skip: !process.env.INTENT_TEST_DOCKER_IMAGE, timeout: 45000 }, async t => {
  const f = await boundJournalFixture(t, process.env.INTENT_TEST_DOCKER_IMAGE), runner = new IsolatedTestRunnerService(f.persistence);
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node proof.cjs' } }));
  await writeFile(join(f.root, 'proof.cjs'), 'console.log("running-bound-test");setInterval(()=>{},1000);');
  const docker = promisify(execFile), controller = new AbortController();
  const running = runner.run({ workingDirectory: f.root, script: 'test:unit', timeoutMs: 30000, execution: f.identity, signal: controller.signal });
  try {
    let live = false;
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const attempt = f.operations.list('session')[0].isolatedTestAttempts?.[0];
      if (attempt?.phase === 'running') {
        const state = await docker('docker', ['inspect', attempt.containerName, '--format', '{{.State.Running}}'], { windowsHide: true }).catch(() => undefined);
        if (state?.stdout.trim() === 'true') { live = true; break; }
      }
      if (attempt?.phase === 'finished') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(live, true, JSON.stringify(f.row()));
    await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].intentTestAuthority!.grant.revokedAt = new Date().toISOString(); });
    const result = await running;
    assert.equal(result.aborted, true); assert.equal(result.error, 'ISOLATED_TEST_ABORTED');
    assert.equal(result.isolation.stopConfirmed, true); assert.equal(result.isolation.cleanupRequired, false);
    assert.equal(f.row().phase, 'finished'); assert.equal(f.row().result?.aborted, true);
    assert.equal(f.operations.list('session')[0].isolatedTestAttempts!.length, 1); assert.equal(f.operations.list('session')[0].attemptsUsed, 1);
    await assert.rejects(docker('docker', ['inspect', f.row().containerName], { windowsHide: true }), /No such/i);
    await assert.rejects(readFile(join(f.row().snapshotDirectory!, 'source/package.json')));
  } finally { controller.abort(); await running; }
});

test('journal reservation is durable, unique, owned and cannot rewrite snapshot identity', async t => {
  const f = await journalFixture(t), first = await f.reserve();
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).logicalOperationsBySession.session[0].isolatedTestAttempts[0], first);
  await assert.rejects(f.reserve(), /ALREADY_RESERVED/);
  await assert.rejects(f.store.update(f.identity, 'other', {}), /LEASE_LOST/);
  await f.store.update(f.identity, 'owner', { daemonId: 'daemon' });
  await assert.rejects(f.store.update(f.identity, 'owner', { daemonId: 'different' }), /IDENTITY_MISMATCH/);
  assert.equal(await f.store.claimRecovery(f.identity, 'recovery'), undefined);
  f.advance(31_000);
  assert.ok(await f.store.claimRecovery(f.identity, 'recovery'));
  await assert.rejects(f.store.update(f.identity, 'owner', {}), /LEASE_LOST/);
  assert.equal(f.operations.list('session')[0].stopState, 'unconfirmed');
  await f.operations.settle('session', 'operation', 'invocation', 'confirmed');
  assert.equal(f.operations.list('session')[0].stopState, 'unconfirmed', 'late adapter cannot confirm a recovery-owned process');
  await f.store.finishRecovery(f.identity, 'recovery', true);
  assert.equal(f.row().result?.error, 'ISOLATED_TEST_RESULT_LOST');
  assert.equal(f.row().result?.exitCode, null);
  assert.equal(f.operations.list('session')[0].status, 'interrupted');
  assert.equal(f.operations.list('session')[0].activeInvocationId, undefined);
  await assert.rejects(f.operations.reserve('session', 'operation', 'implicit-retry'), /REQUIRES_RESUME/);
  assert.equal(f.operations.list('session')[0].attemptsUsed, 1);
  assert.equal(f.store.candidates().length, 0);
});

test('journal rechecks pause, epoch, generation, deletion and route holds before process launch', async t => {
  for (const change of ['pause', 'epoch', 'generation', 'delete', 'hold']) {
    const f = await journalFixture(t); await f.reserve();
    if (change === 'pause') await f.persistence.setCollection('sessions', [{ ...f.session, status: 'PAUSED' }]);
    if (change === 'epoch') await f.persistence.setCollection('sessions', [{ ...f.session, dataEpoch: 'new' }]);
    if (change === 'generation') await f.persistence.setCollection('sessionLifecyclesBySession', { session: { ...f.lifecycle, generation: 2 } });
    if (change === 'delete') await f.persistence.setCollection('sessions', []);
    if (change === 'hold') await f.persistence.setCollection('workItemsBySession', { session: [{ id: 'work', dispatchHold: { correctionId: 'correction' } }] });
    await assert.rejects(f.store.update(f.identity, 'owner', { phase: 'running' }, true), /ADMISSION_CLOSED|DISPATCH_HELD/, change);
    assert.equal(f.row().phase, 'reserved');
  }
});

test('recovery keeps unknown containers held, then confirms stop without resetting the budget or resurrecting a session', async t => {
  const f = await journalFixture(t); await f.reserve(); f.advance(31_000);
  await f.store.claimRecovery(f.identity, 'first'); await f.store.finishRecovery(f.identity, 'first', false);
  assert.equal(f.row().phase, 'reconciliation_required');
  assert.equal(f.operations.list('session')[0].activeInvocationId, 'invocation');
  await assert.rejects(f.operations.reserve('session', 'operation', 'new'), /STOP_UNCONFIRMED/);
  await f.persistence.setCollection('sessions', []);
  f.advance(31_000); await f.store.claimRecovery(f.identity, 'second'); await f.store.finishRecovery(f.identity, 'second', true);
  assert.deepEqual(f.persistence.getCollection('sessions', []), []);
  assert.equal(f.operations.list('session')[0].status, 'interrupted');
  assert.equal(f.operations.list('session')[0].attemptsUsed, 1);
});

test('recovery refuses another daemon or container label and does not create or start processes', async t => {
  for (const mismatch of ['daemon', 'label', 'missing', 'matching']) {
    const f = await journalFixture(t), attempt = await f.reserve();
    await f.store.update(f.identity, 'owner', { phase: 'running', daemonId: 'daemon', stopConfirmed: false });
    f.advance(31_000);
    const runner = new IsolatedTestRunnerService(f.persistence); (runner as any).store = f.store;
    const commands: string[][] = []; let removed = false;
    (runner as any).command = async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'rm') removed = true;
      const missing = args[0] === 'inspect' && (mismatch === 'missing' || removed);
      return { code: missing ? 1 : 0, stdout: args[0] === 'info' ? (mismatch === 'daemon' ? 'another' : 'daemon') : `${mismatch === 'label' ? 'another' : attempt.identityHash}|${imageId}`,
        stderr: missing ? 'No such container' : '', timedOut: false, aborted: false, truncated: false };
    };
    await runner.recoverExpired();
    assert.equal(removed, mismatch === 'matching');
    assert.equal(f.row().stopConfirmed, ['matching', 'missing'].includes(mismatch));
    assert.ok(!commands.some(args => ['create', 'start'].includes(args[0])));
  }
});

test('journal write failure prevents all Docker side effects', async t => {
  const f = await journalFixture(t), runner = new IsolatedTestRunnerService(f.persistence);
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = imageId;
  t.after(() => { if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  let calls = 0; (runner as any).command = async () => { calls++; };
  const write = (f.persistence as any).writeFileState; (f.persistence as any).writeFileState = () => { throw new Error('injected disk failure'); };
  await assert.rejects(runner.run({ workingDirectory: f.root, script: 'test', timeoutMs: 1000, execution: f.identity }), /disk failure/);
  (f.persistence as any).writeFileState = write;
  assert.equal(calls, 0); assert.equal(f.operations.list('session')[0].isolatedTestAttempts, undefined);
});

test('terminal results remain durable and cannot be renewed or overwritten', async t => {
  const f = await journalFixture(t); await f.reserve();
  await f.store.update(f.identity, 'owner', { phase: 'finished', result: { stdout: 'proof', stderr: '', exitCode: 0, timedOut: false, aborted: false, outputTruncated: false } });
  await assert.rejects(f.store.update(f.identity, 'owner', { phase: 'running' }), /ATTEMPT_TERMINAL/);
  f.advance(31_000); assert.equal(await f.store.claimRecovery(f.identity, 'recovery'), undefined);
  const restored = new PersistenceService({ enabled: true, backend: 'file', filePath: f.file }); await restored.initialize();
  assert.equal(restored.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {}).session[0].isolatedTestAttempts![0].result?.stdout, 'proof');
  await restored.onModuleDestroy();
});

test('a lost Docker create response still reconciles the persisted container identity', async t => {
  const f = await journalFixture(t), runner = new IsolatedTestRunnerService(f.persistence);
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = imageId;
  t.after(() => { if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  let removed = false, starts = 0;
  (runner as any).command = async (args: string[]) => {
    if (args[0] === 'create') { assert.equal(f.row().phase, 'created'); throw new Error('lost response after daemon received create'); }
    if (args[0] === 'start') starts++;
    if (args[0] === 'rm') removed = true;
    return { code: removed && args[0] === 'inspect' ? 1 : 0, stdout: args[0] === 'info' ? 'daemon' : args[0] === 'image' ? 'linux|null' : `${f.row().identityHash}|${imageId}`,
      stderr: removed ? 'No such container' : '', timedOut: false, aborted: false, truncated: false };
  };
  const result = await runner.run({ workingDirectory: f.root, script: 'test', timeoutMs: 10000, execution: f.identity });
  assert.equal(starts, 0); assert.equal(removed, true); assert.equal(result.isolation.stopConfirmed, true);
  assert.equal(f.row().phase, 'finished'); assert.equal(f.row().result?.exitCode, null);
});

test('real Docker process crash recovers from disk without rerunning or publishing a lost result', { skip: !process.env.INTENT_TEST_DOCKER_IMAGE, timeout: 60_000 }, async t => {
  const f = await journalFixture(t);
  const workspace = join(f.root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node proof.cjs' } }));
  await writeFile(join(workspace, 'proof.cjs'), 'console.log("actual-test-started"); setInterval(()=>{},1000);');
  const repository = resolve(process.cwd().endsWith('server') ? '../..' : '.');
  const child = spawn(process.execPath, ['--import', 'tsx', join(repository, 'tests/evaluation/isolated-test-crash-worker.ts'), f.file, workspace], {
    cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      TSX_TSCONFIG_PATH: join(repository, 'apps/server/tsconfig.json'), INTENT_ISOLATED_TEST_IMAGE: process.env.INTENT_TEST_DOCKER_IMAGE }
  });
  let childOutput = ''; child.stdout.on('data', data => { childOutput += data.toString(); }); child.stderr.on('data', data => { childOutput += data.toString(); });
  const exited = once(child, 'exit');
  const docker = promisify(execFile);
  let containerName = '';
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    if (containerName) await docker('docker', ['rm', '--force', containerName], { windowsHide: true }).catch(() => undefined); });
  const limit = Date.now() + 25_000;
  let running = false;
  while (Date.now() < limit && child.exitCode === null && child.signalCode === null) {
    const persisted = JSON.parse(await readFile(f.file, 'utf8'));
    const attempt = persisted.logicalOperationsBySession.session[0].isolatedTestAttempts?.[0];
    if (attempt?.phase === 'running') {
      containerName = attempt.containerName;
      const state = await docker('docker', ['inspect', containerName, '--format', '{{.State.Running}}'], { windowsHide: true }).catch(() => undefined);
      if (state?.stdout.trim() === 'true') { running = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(running, true, childOutput);
  child.kill('SIGKILL'); await exited;
  const restarted = new PersistenceService({ enabled: true, backend: 'file', filePath: f.file }); await restarted.initialize();
  t.after(() => restarted.onModuleDestroy());
  const recovery = new IsolatedTestRunnerService(restarted);
  // Controlled clock advances past the crashed worker's lease; the worker itself was actually killed.
  (recovery as any).store = new IsolatedTestRunStore(restarted, () => Date.now() + 31_000);
  await recovery.recoverExpired();
  const operation = restarted.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {}).session[0];
  const attempt = operation.isolatedTestAttempts![0];
  assert.equal(attempt.phase, 'reconciled'); assert.equal(attempt.stopConfirmed, true); assert.equal(attempt.cleanupRequired, false);
  assert.equal(attempt.result?.error, 'ISOLATED_TEST_RESULT_LOST'); assert.equal(attempt.result?.exitCode, null);
  assert.equal(operation.status, 'interrupted'); assert.equal(operation.activeInvocationId, undefined); assert.equal(operation.attemptsUsed, 1);
  assert.equal(operation.isolatedTestAttempts!.length, 1);
  await assert.rejects(docker('docker', ['inspect', containerName], { windowsHide: true }), /No such/i);
  await assert.rejects(readFile(join(attempt.snapshotDirectory!, 'source/package.json')));
  await recovery.recoverExpired();
  assert.equal(restarted.getCollection<Record<string, LogicalOperation[]>>('logicalOperationsBySession', {}).session[0].isolatedTestAttempts!.length, 1);
});

test('real Docker adapter result commits the invocation journal before returning success', { skip: !process.env.INTENT_TEST_DOCKER_IMAGE }, async t => {
  const f = await journalFixture(t), workspace = join(f.root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test proof.cjs' } }));
  await writeFile(join(workspace, 'proof.cjs'), 'require("node:test").test("proof",()=>{});');
  const previous = process.env.INTENT_ISOLATED_TEST_IMAGE; process.env.INTENT_ISOLATED_TEST_IMAGE = process.env.INTENT_TEST_DOCKER_IMAGE;
  t.after(() => { if (previous === undefined) delete process.env.INTENT_ISOLATED_TEST_IMAGE; else process.env.INTENT_ISOLATED_TEST_IMAGE = previous; });
  const runner = new IsolatedTestRunnerService(f.persistence);
  const tool = new TestRunnerTool({ checkInvocation: () => ({ allowed: true }) } as never, undefined, runner);
  const adapter = new TestRunnerRuntimeAdapterService({ getTool: () => tool } as never, { resolveServerRoot: () => workspace } as never);
  const input = makeInvocationPlan({ invocationId: 'invocation', sessionId: 'session', dataEpoch: 'epoch',
    operation: { id: 'operation' } as never, executionTarget: { runtimeType: 'test_runner' }, phase: 'task_execution' });
  const result = await adapter.start(input).result;
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(f.row().phase, 'finished'); assert.equal(f.row().stopConfirmed, true); assert.equal(f.row().cleanupRequired, false);
  assert.equal(f.row().result?.exitCode, 0); assert.match(f.row().result!.stdout, /# pass 1/);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).logicalOperationsBySession.session[0].isolatedTestAttempts[0].phase, 'finished');
  await f.operations.settle('session', 'operation', 'invocation');
  assert.equal(f.operations.list('session')[0].stopState, 'confirmed');
});
