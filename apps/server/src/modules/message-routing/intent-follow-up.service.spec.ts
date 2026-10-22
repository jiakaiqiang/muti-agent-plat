import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import test from 'node:test';
import { intentUnderstandingExample } from '@agent-cluster/shared';
import { routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { IntentSourceAuthorizationService } from './intent-source-authorization.service.js';
import { IntentFollowUpService } from './intent-follow-up.service.js';
import { FOLLOW_UP_COLLECTIONS, followUpQuiescent, approveFollowUpInDraft } from './intent-follow-up-state.js';
import { IntentSourceReconciliationService } from './intent-source-reconciliation.service.js';
import { sourceWriteFixture } from './intent-source.test-support.js';
import { chmod, link, symlink, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSourceAuthorizationCandidates } from './intent-source-authorization-candidates.js';

async function followUpFixture() {
  const f = await sourceWriteFixture();
  const session = f.persistence.getCollection<any[]>('sessions', [])[0];
  await f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].participatingAgentIds = []; });
  const work = f.persistence.getCollection<any>('workItemsBySession', {})[session.id][0];
  const now = new Date().toISOString();
  const understanding: any = structuredClone(intentUnderstandingExample);
  Object.assign(understanding.segments[0], { dialogueAct: 'command', goal: '增加空密码校验', scopeRelation: 'same_requirement', suggestedAction: 'enqueue_follow_up', contextPolicy: 'inherit_confirmed',
    target: { workItemId: work.id, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
    requestedEffects: [{ kind: 'modify_source', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }, { kind: 'read_workspace', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }],
    evidence: [{ refId: 'request', sourceEventId: 'source-request', start: 0, end: 12, quote: '请修改清单中的登录实现。' }] });
  const events = f.persistence.getCollection<any>('eventsBySession', {})[session.id];
  const tasks = f.persistence.getCollection<any>('tasksBySession', {})[session.id];
  const works = f.persistence.getCollection<any>('workItemsBySession', {})[session.id];
  const snapshots = [{ id: 'follow-snapshot', sessionId: session.id, dataEpoch: session.dataEpoch, sourceEventId: 'source-request', activeWorkItemId: work.id, currentMessage: '请修改清单中的登录实现。',
    businessFingerprint: routingBusinessFingerprint(session, works, events, tasks), validDecisionIds: [], validDecisions: [], candidateWorkItemIds: [work.id], candidateWorkItems: [{ id: work.id, title: '登录', goal: '登录', status: work.status, revision: work.revision }],
    revision: { sessionRevision: session.revision, activeWorkItemId: work.id, activeWorkItemRevision: work.revision, decisionLedgerRevision: 1, latestEventSeq: 1 }, snapshotHash: 'follow-snapshot', createdAt: now }];
  const route: any = { id: 'follow-route', sessionId: session.id, sourceEventId: 'source-request', sessionSeq: 2, status: 'VALIDATING', policyVersion: 'intent-policy-v1', rolloutMode: 'active', reasonCodes: [], retryCount: 0, idempotencyKey: 'follow-route-key', routingRevision: 1,
    semanticContractVersion: 'intent-understanding-v1', semanticProposal: { contractVersion: 'intent-understanding-v1', dataEpoch: session.dataEpoch, sessionGeneration: 1, snapshotId: 'follow-snapshot', understanding }, createdAt: now, updatedAt: now };
  await f.persistence.mutateCollections(['contextSnapshotsBySession', 'intentRoutingRecordsBySession'], (draft: any) => {
    draft.contextSnapshotsBySession = { ...(draft.contextSnapshotsBySession ?? {}), [session.id]: snapshots };
    draft.intentRoutingRecordsBySession = { ...(draft.intentRoutingRecordsBySession ?? {}), [session.id]: [...(draft.intentRoutingRecordsBySession?.[session.id] ?? []), route] };
  });
  const authorizations = new IntentSourceAuthorizationService(f.persistence);
  const service = new IntentFollowUpService(f.persistence, authorizations, { schedule: () => undefined } as any);
  return { f, sessionId: session.id, actorId: session.ownerId, route, service, authorizations };
}

async function queueFollowUp(fixture: Awaited<ReturnType<typeof followUpFixture>>) {
  const result = await fixture.service.tryCommit({ sessionId: fixture.sessionId, routingId: fixture.route.id, actorId: fixture.actorId, expectedRoutingRevision: 1 });
  return { result, follow: fixture.f.persistence.getCollection<any[]>('sessions', [])[0].intentFollowUps[0] };
}

test('R10b authorization is owner-decided, scoped, CAS-protected and idempotent', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  await assert.rejects(() => fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'client-paths', paths: ['src/login.ts'], prohibitions: [] }), /INTENT_SOURCE_AUTHORIZATION_INPUT_INVALID/);
  const request = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'scope-request' });
  assert.deepEqual(request.candidateRefs, []);
  const replay = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'scope-request' });
  assert.equal(replay.id, request.id);
  const candidates = await fixture.authorizations.candidates(fixture.sessionId, request.id, fixture.actorId, { query: 'login' });
  const loginRef = candidates.candidates[0].ref;
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, { action: 'approve', expectedRequestRevision: 99, expectedSessionRevision: 1, idempotencyKey: 'cas-conflict', candidateRefs: [loginRef], prohibitions: [] }), /INTENT_SOURCE_AUTHORIZATION_REVISION_CONFLICT/);
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, { action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'empty-scope', candidateRefs: [], prohibitions: [] }), /INTENT_SOURCE_EXACT_FILES_REQUIRED/);
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, { action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'outside-scope', candidateRefs: ['forged'], prohibitions: [] }), /INTENT_SOURCE_CANDIDATE_REF_INVALID/);
  const approved = await fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, { action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'approve-scope', candidateRefs: [loginRef], prohibitions: ['no_schema_change'] });
  assert.equal(approved.request.status, 'approved'); assert.deepEqual(approved.request.candidateRefs, [loginRef]); assert.equal(approved.authority?.files.length, 1);
  const approvedReplay = await fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, { action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'approve-scope', candidateRefs: [loginRef], prohibitions: ['no_schema_change'] });
  assert.equal(approvedReplay.request.id, approved.request.id);
});

test('R10b enqueue preserves active execution and is idempotent', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  const before: any = fixture.f.persistence.snapshotState(); const queued = await queueFollowUp(fixture); const after: any = fixture.f.persistence.snapshotState();
  assert.equal(queued.follow.status, 'queued'); assert.equal(after.workItemsBySession[fixture.sessionId][0].requirementRevision, before.workItemsBySession[fixture.sessionId][0].requirementRevision); assert.equal(after.workItemsBySession[fixture.sessionId][0].executionEpoch, before.workItemsBySession[fixture.sessionId][0].executionEpoch);
  assert.deepEqual(after.decisionRecordsBySession?.[fixture.sessionId] ?? [], before.decisionRecordsBySession?.[fixture.sessionId] ?? []); assert.equal(after.tasksBySession[fixture.sessionId][0].status, before.tasksBySession[fixture.sessionId][0].status); assert.deepEqual(after.logicalOperationsBySession[fixture.sessionId][0].executionBinding, before.logicalOperationsBySession[fixture.sessionId][0].executionBinding);
  const replay = await fixture.service.tryCommit({ sessionId: fixture.sessionId, routingId: fixture.route.id, actorId: fixture.actorId, expectedRoutingRevision: 2 }); assert.equal(replay.idempotentReplay, true); assert.equal(fixture.f.persistence.getCollection<any[]>('sessions', [])[0].intentFollowUps.length, 1);
});

test('R10b quiescence blocks pending task states, workflow, budget hold, R8, R9 and writeback', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup()); const { follow } = await queueFollowUp(fixture); const base = fixture.f.persistence.snapshotState();
  for (const status of ['pending', 'assigned', 'waiting', 'claimed']) { const state: any = structuredClone(base); state.tasksBySession[fixture.sessionId][0].status = status; assert.equal(followUpQuiescent(state, state.sessions[0], follow), false, `task ${status}`); }
  const workflowState: any = structuredClone(base); workflowState.workflowRuntime = { runs: [{ sessionId: fixture.sessionId, status: 'running' }] }; assert.equal(followUpQuiescent(workflowState, workflowState.sessions[0], follow), false);
  const budgetState: any = structuredClone(base); budgetState.logicalOperationsBySession[fixture.sessionId][0].inputBudgetDecisions = [{ status: 'pending', dataEpoch: 'epoch', sessionGeneration: 1 }]; assert.throws(() => followUpQuiescent(budgetState, budgetState.sessions[0], follow), /INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED/);
  const r8State: any = structuredClone(base); r8State.intentPlanStepsBySession[fixture.sessionId][0].status = 'reconciliation_required'; assert.equal(followUpQuiescent(r8State, r8State.sessions[0], follow), false);
  const r9State: any = structuredClone(base); r9State.intentReconciliationsBySession = { [fixture.sessionId]: [{ status: 'open' }] }; assert.equal(followUpQuiescent(r9State, r9State.sessions[0], follow), false);
  const writebackState: any = structuredClone(base); writebackState.workspaceWritebacks = [{ sessionId: fixture.sessionId, status: 'applying' }]; assert.equal(followUpQuiescent(writebackState, writebackState.sessions[0], follow), false);
});

test('R10b scan persists activation failures and does not retry the blocked follow-up', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup()); await queueFollowUp(fixture); (fixture.service as any).activate = async () => { throw new ConflictException('TEST_ACTIVATION_FAILURE'); };
  await (fixture.service as any).scan(); const blocked = fixture.f.persistence.getCollection<any[]>('sessions', [])[0].intentFollowUps[0]; assert.equal(blocked.status, 'blocked'); assert.equal(blocked.failureCode, 'TEST_ACTIVATION_FAILURE');
  const events = fixture.f.persistence.getCollection<any>('eventsBySession', {})[fixture.sessionId]; assert.equal(events.filter((event: any) => event.type === 'intent_plan_blocked').length, 1); await (fixture.service as any).scan(); const eventsAfter = fixture.f.persistence.getCollection<any>('eventsBySession', {})[fixture.sessionId]; assert.equal(eventsAfter.filter((event: any) => event.type === 'intent_plan_blocked').length, 1);
});

test('R10b activation increments once and owner Brief confirmation creates one task', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup()); const { follow } = await queueFollowUp(fixture);
  await fixture.f.persistence.mutateCollections(['tasksBySession', 'logicalOperationsBySession', 'intentPlanStepsBySession', 'briefsBySession', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.tasksBySession[fixture.sessionId][0].status = 'completed'; draft.logicalOperationsBySession[fixture.sessionId][0].activeInvocationId = undefined; draft.logicalOperationsBySession[fixture.sessionId][0].stopState = 'confirmed'; draft.logicalOperationsBySession[fixture.sessionId][0].status = 'completed';
    for (const step of draft.intentPlanStepsBySession[fixture.sessionId]) step.status = 'completed'; draft.briefsBySession[fixture.sessionId][0].intentBinding = { stepId: 'original-step', intentRevision: 1, requirementRevision: 1, dataEpoch: 'epoch', sessionGeneration: 1 }; draft.sessionLifecyclesBySession[fixture.sessionId].admission = 'open'; draft.sessionLifecyclesBySession[fixture.sessionId].stopStatus = 'idle';
  });
  const activated = await fixture.service.activate(fixture.sessionId, follow.id, fixture.actorId); assert.equal(activated.status, 'brief'); const work = fixture.f.persistence.getCollection<any>('workItemsBySession', {})[fixture.sessionId][0]; assert.equal(work.requirementRevision, 2);
  const briefStep = fixture.f.persistence.getCollection<any>('intentPlanStepsBySession', {})[fixture.sessionId].find((row: any) => row.id === activated.briefStepId); const brief: any = { id: activated.briefStepId, sessionId: fixture.sessionId, workItemId: work.id, version: 1, confirmedByUser: true,
    intentConfirmationReceipt: { id: 'follow-confirmation', actorId: fixture.actorId, request: { contractVersion: 'intent-brief-confirm-v1', dataEpoch: 'epoch', confirmationId: 'follow-card', expectedBriefVersion: 1, expectedIntentRevision: briefStep.intentRevision, idempotencyKey: 'follow-confirmation-key' }, sourceEventId: 'source-request', requirementRevision: 2, resultStatus: 'WAIT_WORKFLOW_SELECT', createdAt: new Date().toISOString() }, intentBinding: { stepId: activated.briefStepId, intentRevision: briefStep.intentRevision, requirementRevision: 2, dataEpoch: 'epoch', sessionGeneration: 1 }, acceptanceCriteria: [] };
  await fixture.f.persistence.mutateCollections(FOLLOW_UP_COLLECTIONS, (draft: any) => { draft.briefsBySession[fixture.sessionId] = [brief]; approveFollowUpInDraft(draft, draft.sessions.find((row: any) => row.id === fixture.sessionId), brief); });
  const tasks = fixture.f.persistence.getCollection<any>('tasksBySession', {})[fixture.sessionId].filter((row: any) => row.id.startsWith('followup-task:')); assert.equal(tasks.length, 1); assert.equal(fixture.f.persistence.getCollection<any[]>('sessions', [])[0].intentFollowUps[0].status, 'ready');
});

test('R10b source unknown claim requires current evidence and is idempotent', async t => {
  const f = await sourceWriteFixture(); t.after(() => f.cleanup()); await f.candidates.prepare(f.plan); await f.candidates.capture(f.plan, f.proposal); const claim = await f.store.beginApply(f.binding, { writebackId: 'writeback', attemptId: 'attempt' }); await f.store.finishApply(claim, 'unknown'); const service = new IntentSourceReconciliationService(f.persistence);
  await assert.rejects(() => service.decide('session', claim.id, 'user', { action: 'confirm_completed', expectedEvidenceHash: 'stale', idempotencyKey: 'stale' }), /INTENT_SOURCE_RECONCILIATION_EVIDENCE_STALE/); await writeFile(`${f.root}/${f.path}`, f.updated, 'utf8'); const current = (await service.view('session', 'user'))[0]; assert.equal(current.actions.find((action: any) => action.action === 'confirm_completed')?.enabled, true);
  const resolved = await service.decide('session', claim.id, 'user', { action: 'confirm_completed', expectedEvidenceHash: current.evidence.evidenceHash, idempotencyKey: 'confirm' }); assert.ok(resolved); assert.equal(resolved.action, 'confirm_completed'); const replay = await service.decide('session', claim.id, 'user', { action: 'confirm_completed', expectedEvidenceHash: current.evidence.evidenceHash, idempotencyKey: 'confirm' }); assert.ok(replay); assert.equal(replay.action, 'confirm_completed'); assert.equal((await service.view('session', 'user')).length, 0);
});

async function activateToBrief(fixture: Awaited<ReturnType<typeof followUpFixture>>) {
  const { follow } = await queueFollowUp(fixture);
  await fixture.f.persistence.mutateCollections(['tasksBySession', 'logicalOperationsBySession', 'intentPlanStepsBySession', 'briefsBySession', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.tasksBySession[fixture.sessionId][0].status = 'completed';
    draft.logicalOperationsBySession[fixture.sessionId][0].activeInvocationId = undefined;
    draft.logicalOperationsBySession[fixture.sessionId][0].stopState = 'confirmed';
    draft.logicalOperationsBySession[fixture.sessionId][0].status = 'completed';
    for (const step of draft.intentPlanStepsBySession[fixture.sessionId]) step.status = 'completed';
    draft.briefsBySession[fixture.sessionId][0].intentBinding = { stepId: 'original-step', intentRevision: 1, requirementRevision: 1, dataEpoch: 'epoch', sessionGeneration: 1 };
    draft.sessionLifecyclesBySession[fixture.sessionId].admission = 'open';
    draft.sessionLifecyclesBySession[fixture.sessionId].stopStatus = 'idle';
  });
  return { follow: await fixture.service.activate(fixture.sessionId, follow.id, fixture.actorId) };
}

test('M013 baseline changes block activation with durable failure and no new Brief step', async t => {
  const cases = [
    ['file hash', async (fixture: Awaited<ReturnType<typeof followUpFixture>>) => { await writeFile(`${fixture.f.root}/${fixture.f.path}`, fixture.f.updated, 'utf8'); }],
    ['decision set', async (fixture: Awaited<ReturnType<typeof followUpFixture>>) => { await fixture.f.persistence.mutateCollections(['decisionRecordsBySession'], (draft: any) => { (draft.decisionRecordsBySession[fixture.sessionId] ??= []).push({ id: 'm013-decision', workItemId: 'work', revision: 1, status: 'confirmed', kind: 'constraint', content: '新增约束' }); }); }],
    ['workspace binding', async (fixture: Awaited<ReturnType<typeof followUpFixture>>) => { await fixture.f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].workspaceContext.binding.boundAt = new Date().toISOString(); }); }]
  ] as const;
  for (const [label, mutate] of cases) {
    const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
    const { follow } = await queueFollowUp(fixture);
    const before: any = fixture.f.persistence.snapshotState();
    await fixture.f.persistence.mutateCollections(['tasksBySession', 'logicalOperationsBySession', 'intentPlanStepsBySession', 'briefsBySession', 'sessionLifecyclesBySession'], (draft: any) => {
      draft.tasksBySession[fixture.sessionId][0].status = 'completed';
      draft.logicalOperationsBySession[fixture.sessionId][0].activeInvocationId = undefined;
      draft.logicalOperationsBySession[fixture.sessionId][0].stopState = 'confirmed';
      draft.logicalOperationsBySession[fixture.sessionId][0].status = 'completed';
      for (const step of draft.intentPlanStepsBySession[fixture.sessionId]) step.status = 'completed';
      draft.briefsBySession[fixture.sessionId][0].intentBinding = { stepId: 'original-step', intentRevision: 1, requirementRevision: 1, dataEpoch: 'epoch', sessionGeneration: 1 };
      draft.sessionLifecyclesBySession[fixture.sessionId].admission = 'open';
      draft.sessionLifecyclesBySession[fixture.sessionId].stopStatus = 'idle';
    });
    await mutate(fixture);
    const result = await fixture.service.activate(fixture.sessionId, follow.id, fixture.actorId);
    const state: any = fixture.f.persistence.snapshotState();
    const stored = state.sessions[0].intentFollowUps[0];
    assert.equal(stored.status, 'blocked', label);
    assert.equal(stored.failureCode, 'INTENT_FOLLOW_UP_BASELINE_CHANGED', label);
    assert.equal(stored.baseline.requirementRevision, before.sessions[0].intentFollowUps[0].baseline.requirementRevision, label);
    assert.equal(state.workItemsBySession[fixture.sessionId][0].requirementRevision, before.workItemsBySession[fixture.sessionId][0].requirementRevision, label);
    assert.equal(state.intentPlanStepsBySession[fixture.sessionId].length, before.intentPlanStepsBySession[fixture.sessionId].length, label);
    assert.equal(result.status, 'blocked', label);
  }
});

test('M013 concurrent activation and restart are durable and single-shot', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  const { follow } = await queueFollowUp(fixture);
  await fixture.f.persistence.mutateCollections(['tasksBySession', 'logicalOperationsBySession', 'intentPlanStepsBySession', 'briefsBySession', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.tasksBySession[fixture.sessionId][0].status = 'completed'; draft.logicalOperationsBySession[fixture.sessionId][0].activeInvocationId = undefined; draft.logicalOperationsBySession[fixture.sessionId][0].stopState = 'confirmed'; draft.logicalOperationsBySession[fixture.sessionId][0].status = 'completed';
    for (const step of draft.intentPlanStepsBySession[fixture.sessionId]) step.status = 'completed'; draft.briefsBySession[fixture.sessionId][0].intentBinding = { stepId: 'original-step', intentRevision: 1, requirementRevision: 1, dataEpoch: 'epoch', sessionGeneration: 1 }; draft.sessionLifecyclesBySession[fixture.sessionId].admission = 'open'; draft.sessionLifecyclesBySession[fixture.sessionId].stopStatus = 'idle';
  });
  const second = new IntentFollowUpService(fixture.f.persistence, fixture.authorizations, { schedule: () => undefined } as any);
  const [first, concurrent] = await Promise.all([fixture.service.activate(fixture.sessionId, follow.id, fixture.actorId), second.activate(fixture.sessionId, follow.id, fixture.actorId)]);
  const third = new IntentFollowUpService(fixture.f.persistence, fixture.authorizations, { schedule: () => undefined } as any);
  await third.activate(fixture.sessionId, follow.id, fixture.actorId); await (third as any).scan();
  const state: any = fixture.f.persistence.snapshotState(), stored = state.sessions[0].intentFollowUps[0];
  assert.equal(first.status, 'brief'); assert.equal(concurrent.status, 'brief'); assert.equal(stored.status, 'brief');
  assert.equal(state.workItemsBySession[fixture.sessionId][0].requirementRevision, 2);
  assert.equal(state.intentPlanStepsBySession[fixture.sessionId].filter((row: any) => row.step.action === 'prepare_brief').length, 1);
  assert.equal(state.followUpMessagesBySession[fixture.sessionId].filter((row: any) => row.id === follow.id && row.status === 'planning').length, 1);
  second.onModuleDestroy(); third.onModuleDestroy();
});

test('M013 Brief rejection and follow-up cancellation create no dispatch or LogicalOperation', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  const before: any = fixture.f.persistence.snapshotState();
  const queued = await queueFollowUp(fixture);
  const cancelledQueued = await fixture.service.cancel(fixture.sessionId, queued.follow.id, fixture.actorId, queued.follow.revision);
  assert.equal(cancelledQueued.status, 'cancelled');
  let state: any = fixture.f.persistence.snapshotState();
  assert.equal(state.tasksBySession[fixture.sessionId].filter((row: any) => row.id.startsWith('followup-task:')).length, 0);
  assert.deepEqual(state.logicalOperationsBySession[fixture.sessionId], before.logicalOperationsBySession[fixture.sessionId]);
  const secondFixture = await followUpFixture(); t.after(() => secondFixture.f.cleanup());
  const activated = await activateToBrief(secondFixture); const cancelledBrief = await secondFixture.service.cancel(secondFixture.sessionId, activated.follow.id, secondFixture.actorId, activated.follow.revision);
  assert.equal(cancelledBrief.status, 'cancelled'); state = secondFixture.f.persistence.snapshotState();
  assert.equal(state.tasksBySession[secondFixture.sessionId].filter((row: any) => row.id.startsWith('followup-task:')).length, 0);
  assert.deepEqual((state.logicalOperationsBySession as any)[secondFixture.sessionId], ((await secondFixture.f.persistence.snapshotState()).logicalOperationsBySession as any)[secondFixture.sessionId]);
  assert.equal((state.followUpMessagesBySession[secondFixture.sessionId] as any[]).find((row: any) => row.id === activated.follow.id).status, 'cancelled');
});

test('M015 candidate search applies the query while traversing beyond 500 entries and reaches deep files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'intent-candidates-m015-')); t.after(() => rm(root, { recursive: true, force: true }));
  // The noise must be traversed (not gitignored) and sort before the needle, so the
  // pre-M015 "cap 500 entries, then filter" scan would stop before reaching z1/.
  const noise = join(root, 'noise'); await mkdir(noise, { recursive: true });
  await Promise.all(Array.from({ length: 610 }, (_, index) => writeFile(join(noise, `file-${String(index).padStart(3, '0')}.ts`), `export const value${index} = ${index};`, 'utf8')));
  await mkdir(join(root, 'z1', 'z2', 'z3', 'z4'), { recursive: true });
  await writeFile(join(root, 'z1', 'z2', 'z3', 'z4', 'needle.ts'), 'export const needle = true;', 'utf8');
  const scanned = await scanSourceAuthorizationCandidates({ rootPath: root, query: 'needle', suggestedPaths: new Set(), scanBudget: { maxMs: 10_000 } });
  assert.deepEqual(scanned.filtered.map(row => row.path), ['z1/z2/z3/z4/needle.ts']);
  assert.equal(scanned.truncated, false);
});

test('M015 candidate scan reports an explicit reason when its independent budget is exhausted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'intent-candidates-budget-m015-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 10; index++) await writeFile(join(root, `file-${index}.ts`), 'export const value = true;', 'utf8');
  const scanned = await scanSourceAuthorizationCandidates({ rootPath: root, query: 'missing', suggestedPaths: new Set(), scanBudget: { maxEntries: 3, maxMs: 1000 } });
  assert.equal(scanned.truncated, true);
  assert.equal(scanned.truncatedReason, 'entry_scan_budget_exhausted');
});

test('M015 cancellation is revision guarded and same-key replay returns the same result', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  const queued = await queueFollowUp(fixture);
  const input = { expectedRevision: queued.follow.revision, idempotencyKey: 'm015-cancel-once' };
  const first = await fixture.service.cancel(fixture.sessionId, queued.follow.id, fixture.actorId, input);
  const replay = await fixture.service.cancel(fixture.sessionId, queued.follow.id, fixture.actorId, input);
  assert.deepEqual(replay, first);
  await assert.rejects(() => fixture.service.cancel(fixture.sessionId, queued.follow.id, fixture.actorId, { expectedRevision: first.revision, idempotencyKey: 'm015-cancel-other' }), /INTENT_FOLLOW_UP_REVISION_CONFLICT/);
  for (const status of ['cancelled', 'ready'] as const) {
    const other = await followUpFixture(); t.after(() => other.f.cleanup());
    const queuedOther = await queueFollowUp(other);
    await other.f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].intentFollowUps[0].status = status; });
    await assert.rejects(() => other.service.cancel(other.sessionId, queuedOther.follow.id, other.actorId, { expectedRevision: queuedOther.follow.revision, idempotencyKey: `m015-${status}` }), /INTENT_FOLLOW_UP_REVISION_CONFLICT/);
  }
});

test('M013 unknown claim redispatch is single-use and abandon blocks apply, with idempotent decisions', async t => {
  const redispatch = await sourceWriteFixture(); t.after(() => redispatch.cleanup()); await redispatch.candidates.prepare(redispatch.plan); await redispatch.candidates.capture(redispatch.plan, redispatch.proposal);
  const claim = await redispatch.store.beginApply(redispatch.binding, { writebackId: 'writeback', attemptId: 'attempt' }); await redispatch.store.finishApply(claim, 'unknown'); const service = new IntentSourceReconciliationService(redispatch.persistence); const view = (await service.view('session', 'user'))[0];
  const decision = await service.decide('session', claim.id, 'user', { action: 'redispatch', expectedEvidenceHash: view.evidence.evidenceHash, idempotencyKey: 'redispatch-once' });
  assert.equal((await service.decide('session', claim.id, 'user', { action: 'redispatch', expectedEvidenceHash: view.evidence.evidenceHash, idempotencyKey: 'redispatch-once' }))?.action, 'redispatch'); assert.equal(decision?.action, 'redispatch');
  const first = await redispatch.store.beginApply(redispatch.binding, { writebackId: 'writeback-2', attemptId: 'attempt-2' }); await redispatch.store.finishApply(first, 'not_applied');
  await assert.rejects(() => redispatch.store.beginApply(redispatch.binding, { writebackId: 'writeback-3', attemptId: 'attempt-3' }), /INTENT_SOURCE_CANDIDATE_REDISPATCH_ALREADY_USED/);
  const abandon = await sourceWriteFixture(); t.after(() => abandon.cleanup()); await abandon.candidates.prepare(abandon.plan); await abandon.candidates.capture(abandon.plan, abandon.proposal); const abandonedClaim = await abandon.store.beginApply(abandon.binding, { writebackId: 'writeback', attemptId: 'attempt' }); await abandon.store.finishApply(abandonedClaim, 'unknown'); const abandonService = new IntentSourceReconciliationService(abandon.persistence); const abandonView = (await abandonService.view('session', 'user'))[0];
  const abandoned = await abandonService.decide('session', abandonedClaim.id, 'user', { action: 'abandon', expectedEvidenceHash: abandonView.evidence.evidenceHash, idempotencyKey: 'abandon-once' });
  assert.equal((await abandonService.decide('session', abandonedClaim.id, 'user', { action: 'abandon', expectedEvidenceHash: abandonView.evidence.evidenceHash, idempotencyKey: 'abandon-once' }))?.action, 'abandon'); assert.equal(abandoned?.action, 'abandon');
  await assert.rejects(() => abandon.store.beginApply(abandon.binding, { writebackId: 'writeback-2', attemptId: 'attempt-2' }), /INTENT_SOURCE_CANDIDATE_ABANDONED/);
});

test('M014 authorization candidates filter sensitive files, honor gitignore, paginate, and mark only server evidence as suggested', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  await writeFile(`${fixture.f.root}/.gitignore`, 'src/ignored.ts\n*.log\n', 'utf8');
  await writeFile(`${fixture.f.root}/src/ignored.ts`, 'ignored\n', 'utf8');
  await writeFile(`${fixture.f.root}/src/second.ts`, 'second\n', 'utf8');
  await writeFile(`${fixture.f.root}/src/third.ts`, 'third\n', 'utf8');
  await writeFile(`${fixture.f.root}/.env`, 'TOKEN=secret\n', 'utf8');
  await writeFile(`${fixture.f.root}/secret.pem`, 'PRIVATE KEY\n', 'utf8');
  await writeFile(`${fixture.f.root}/image.bin`, Buffer.from([0, 1, 2, 3]));
  await writeFile(`${fixture.f.root}/large.ts`, 'x'.repeat(256 * 1024 + 1), 'utf8');
  try { await symlink(`${fixture.f.root}/src/login.ts`, `${fixture.f.root}/src/link.ts`); }
  catch (error: any) { if (error.code !== 'EPERM') throw error; }
  try { await link(`${fixture.f.root}/src/second.ts`, `${fixture.f.root}/src/hard-link.ts`); }
  catch (error: any) { if (error.code !== 'EPERM') throw error; }
  await fixture.f.persistence.mutateCollections(['sessions', 'intentRoutingRecordsBySession'], (draft: any) => {
    const session = draft.sessions[0];
    session.workspaceSnapshot = { files: [{ path: 'src/login.ts', content: fixture.f.base }], tree: [], skipped: [] };
    draft.intentRoutingRecordsBySession[fixture.sessionId].find((row: any) => row.id === fixture.route.id).semanticProposal.understanding.segments[0].evidence = [
      { refId: 'src/login.ts', sourceEventId: 'source-request', start: 0, end: 3, quote: '请修改' }
    ];
  });
  const request = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'm014-candidates' });
  const first = await fixture.authorizations.candidates(fixture.sessionId, request.id, fixture.actorId, { limit: 2 });
  assert.ok(first.candidates.length <= 2); assert.ok(first.nextCursor);
  assert.ok(first.candidates.every((candidate: any) => !candidate.ref.includes(candidate.path)));
  assert.ok(first.candidates.every((candidate: any) => candidate.expiresAt));
  const listed = [...first.candidates];
  const second = await fixture.authorizations.candidates(fixture.sessionId, request.id, fixture.actorId, { limit: 2, cursor: first.nextCursor });
  listed.push(...second.candidates);
  const paths = new Set(listed.map((candidate: any) => candidate.path));
  assert.equal(paths.has('src/ignored.ts'), false); assert.equal(paths.has('.env'), false); assert.equal(paths.has('secret.pem'), false);
  assert.equal(paths.has('image.bin'), false); assert.equal(paths.has('large.ts'), false);
  assert.equal(paths.has('src/login.ts'), true); assert.equal(paths.has('src/second.ts'), false); assert.equal(paths.has('src/third.ts'), true);
  assert.equal(listed.some((candidate: any) => candidate.path === 'src/login.ts' && candidate.suggested), true);
  const query = await fixture.authorizations.candidates(fixture.sessionId, request.id, fixture.actorId, { query: 'third', limit: 50 });
  assert.deepEqual(query.candidates.map((candidate: any) => candidate.path), ['src/third.ts']);
  assert.equal(query.candidates[0].suggested, false);
});

test('M014 approval accepts only current candidate references and rejects paths, forged, cross-request, and stale references', async t => {
  const fixture = await followUpFixture(); t.after(() => fixture.f.cleanup());
  await writeFile(`${fixture.f.root}/src/second.ts`, 'second\n', 'utf8');
  const request = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'm014-approve' });
  const candidates = await fixture.authorizations.candidates(fixture.sessionId, request.id, fixture.actorId, { query: 'login' });
  const login = candidates.candidates.find((candidate: any) => candidate.path === 'src/login.ts');
  assert.ok(login);
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, {
    action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'legacy-paths', paths: ['src/login.ts'], prohibitions: []
  }), /INTENT_SOURCE_AUTHORIZATION_DECISION_INVALID/);
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, {
    action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'forged-ref', candidateRefs: ['forged-ref'], prohibitions: []
  }), /INTENT_SOURCE_CANDIDATE_REF_INVALID/);
  const other = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'm014-other' });
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, other.id, fixture.actorId, {
    action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'cross-request', candidateRefs: [login.ref], prohibitions: []
  }), /INTENT_SOURCE_CANDIDATE_REF_INVALID/);
  await writeFile(`${fixture.f.root}/src/login.ts`, `${fixture.f.base}// changed after listing\n`, 'utf8');
  await assert.rejects(() => fixture.authorizations.decide(fixture.sessionId, request.id, fixture.actorId, {
    action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'stale-ref', candidateRefs: [login.ref], prohibitions: []
  }), /INTENT_SOURCE_CANDIDATE_STALE/);
  const request2 = await fixture.authorizations.request(fixture.sessionId, fixture.actorId, { routingId: fixture.route.id, expectedRoutingRevision: 1, idempotencyKey: 'm014-approve-current' });
  const current = await fixture.authorizations.candidates(fixture.sessionId, request2.id, fixture.actorId, { query: 'login' });
  const approved = await fixture.authorizations.decide(fixture.sessionId, request2.id, fixture.actorId, {
    action: 'approve', expectedRequestRevision: 1, expectedSessionRevision: 1, idempotencyKey: 'approve-ref', candidateRefs: [current.candidates[0].ref], prohibitions: ['no_schema_change']
  });
  assert.equal(approved.request.status, 'approved'); assert.deepEqual(approved.request.candidateRefs, [current.candidates[0].ref]);
  assert.equal(Object.hasOwn(approved.request as any, 'paths'), false); assert.equal(approved.authority?.files[0]?.path, 'src/login.ts');
});
