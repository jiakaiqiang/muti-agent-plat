import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  CollaborationEvent,
  IntentRoutingDecisionV2,
  IntentRoutingValidation,
  SessionDetail,
  SessionFollowUpMessage
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SummaryCheckpointStore } from '../memory/summary-checkpoint-store.js';
import { ContextManagementService } from './context-management.service.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-context-management-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(directory, 'state.v3.json') });
  await persistence.initialize();
  const now = '2026-08-07T00:00:00.000Z';
  const session: SessionDetail = {
    id: 'session-1',
    dataEpoch: 'epoch-1',
    revision: 1,
    decisionLedgerRevision: 0,
    title: '实现上下文管理',
    originalInput: '实现上下文管理',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: now,
    updatedAt: now
  };
  await persistence.setCollection('sessions', [session]);
  return {
    persistence,
    service: new ContextManagementService(persistence),
    session,
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('routing snapshots ignore progress noise but reject business changes', async () => {
  const context = await fixture();
  try {
    await context.service.ensureInitialWorkItem(context.session, 'initial');
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session, sourceEventId: 'message', currentMessage: '继续', latestEventSeq: 1
    });
    const noise: CollaborationEvent[] = Array.from({ length: 100 }, (_, index) => ({
      id: `progress-${index}`, sessionId: context.session.id, type: 'runtime_progress',
      content: 'heartbeat', toAgentIds: [], actor: { type: 'system', id: 'runtime' },
      metadata: createMetadata('system_notice', { code: 'RUNTIME_HEARTBEAT' }), createdAt: new Date().toISOString()
    }));
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: noise });
    assert.equal(context.service.isSnapshotCurrent(context.session, snapshot, 101), true);
    context.session.tokenUsed += 100;
    context.session.updatedAt = new Date().toISOString();
    assert.equal(context.service.isSnapshotCurrent(context.session, snapshot, 102), true);
    context.session.status = 'WAIT_USER_DECISION';
    assert.equal(context.service.isSnapshotCurrent(context.session, snapshot, 102), false);
    context.session.status = 'AGENT_DISCUSSING';
    await context.persistence.setCollection('tasksBySession', { [context.session.id]: [{
      id: 'task-changing-target', sessionId: context.session.id, status: 'waiting', assignee: { type: 'agent', id: 'worker' }
    }] });
    assert.equal(context.service.isSnapshotCurrent(context.session, snapshot), false, 'task changes must invalidate legal-action context');
    await context.persistence.setCollection('tasksBySession', { [context.session.id]: [] });
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: [
      ...noise, { ...noise[0], id: 'new-requirement', type: 'user_message', content: '新需求' }
    ] });
    assert.equal(context.service.isSnapshotCurrent(context.session, snapshot, 102), false);
  } finally { await context.cleanup(); }
});

test('routing rebuild allowance survives reason replacement and service reconstruction', async () => {
  const context = await fixture();
  try {
    const route = await context.service.createRoutingRecord({ session: context.session,
      sourceEventId: 'message', idempotencyKey: 'rebuild-test', rolloutMode: 'enforce_all_current_epoch' });
    const reserved = await Promise.all([context.service.reserveRoutingRebuild(context.session.id, route.id),
      context.service.reserveRoutingRebuild(context.session.id, route.id)]);
    assert.deepEqual(reserved.sort(), [false, true]);
    await context.service.updateRoutingRecord(context.session.id, route.id, { reasonCodes: ['MODEL_DECISION'] });
    const restored = new ContextManagementService(context.persistence);
    assert.equal(await restored.reserveRoutingRebuild(context.session.id, route.id), false);
    assert.equal(restored.listRoutingRecords(context.session.id)[0].snapshotRebuildCount, 1);
  } finally { await context.cleanup(); }
});

test('a late classifier cannot overwrite a reclaimed routing lease', async () => {
  const context = await fixture();
  try {
    const route = await context.service.createRoutingRecord({ session: context.session,
      sourceEventId: 'message', idempotencyKey: 'lease-test', rolloutMode: 'enforce_all_current_epoch' });
    await context.service.claimIntentRouting(context.session.id, route.id, 'snapshot', 'old-worker');
    await context.service.updateRoutingRecord(context.session.id, route.id, { leaseExpiresAt: new Date(0).toISOString() });
    const claimed = await context.service.claimIntentRouting(context.session.id, route.id, 'snapshot', 'new-worker');
    assert.equal(claimed.state, 'claimed');
    await assert.rejects(context.service.updateRoutingRecord(context.session.id, route.id,
      { status: 'VALIDATING', reasonCodes: ['LATE_RESULT'] }, 'old-worker'), /ROUTING_LEASE_LOST/);
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].leaseOwner, 'new-worker');
  } finally { await context.cleanup(); }
});

test('creates an initial WorkItem and atomically projects it as the active Session context', async () => {
  const context = await fixture();
  try {
    const item = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const persistedSession = context.persistence.getCollection<SessionDetail[]>('sessions', [])[0];

    assert.equal(context.session.activeWorkItemId, item.id);
    assert.equal(persistedSession?.activeWorkItemId, item.id);
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
    assert.equal(item.status, 'OPEN');
  } finally {
    await context.cleanup();
  }
});

test('message ingress atomically commits event, outbox, WorkItem, follow-up and routing projections', async () => {
  const context = await fixture();
  try {
    const event: CollaborationEvent = {
      id: 'event-ingress-1',
      sessionId: context.session.id,
      type: 'user_message',
      userMessageIntent: 'clarification',
      priority: 'normal',
      toAgentIds: [],
      content: 'Continue with the confirmed constraints',
      metadata: {
        ...createMetadata('chat_message', { text: 'Continue with the confirmed constraints' }),
        idempotencyKey: 'message:session-1:client-1'
      },
      actor: { type: 'user', id: 'user-1' },
      createdAt: '2026-08-07T00:00:01.000Z'
    };
    const followUp: SessionFollowUpMessage = {
      id: 'follow-up-ingress-1',
      sourceEventId: event.id,
      content: event.content,
      mentionedAgentIds: [],
      handlingPlan: {
        intent: 'clarification', priority: 'normal', shouldPause: false,
        affectedTaskIds: [], affectedAgentIds: [], requiresBriefRevision: false,
        requiresUserConfirmation: false, coordinatorInstruction: 'pending'
      },
      status: 'queued',
      queuedAt: event.createdAt
    };

    const first = await context.service.commitMessageIngress({
      session: context.session,
      event,
      followUp,
      rolloutMode: 'enforce_all_current_epoch',
      routingIdempotencyKey: 'session-1:event-ingress-1:intent-v2.1'
    });
    const replay = await context.service.commitMessageIngress({
      session: context.session,
      event: { ...event, id: 'event-should-not-commit' },
      followUp: { ...followUp, id: 'follow-up-should-not-commit' },
      rolloutMode: 'enforce_all_current_epoch',
      routingIdempotencyKey: 'session-1:event-should-not-commit:intent-v2.1'
    });

    const events = context.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    const outbox = context.persistence.getCollection<Array<Record<string, unknown>>>('eventOutbox', []);
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(events[context.session.id]?.length, 1);
    assert.equal(outbox.filter((item) => item.id === `outbox:${event.id}`).length, 1);
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
    assert.equal(context.service.listFollowUps(context.session.id).length, 1);
    assert.equal(context.service.listRoutingRecords(context.session.id).length, 1);
  } finally {
    await context.cleanup();
  }
});

test('synchronizes active WorkItem lifecycle status without changing its ownership', async () => {
  const context = await fixture();
  try {
    const item = await context.service.ensureInitialWorkItem(context.session, 'event-1');

    const executing = await context.service.updateActiveWorkItemStatus(context.session, 'EXECUTING');
    const waiting = await context.service.updateActiveWorkItemStatus(context.session, 'WAITING_USER');

    assert.equal(executing?.id, item.id);
    assert.equal(waiting?.id, item.id);
    assert.equal(waiting?.status, 'WAITING_USER');
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
  } finally {
    await context.cleanup();
  }
});

test('related WorkItems inherit only explicit confirmed decisions', async () => {
  const context = await fixture();
  try {
    const first = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const confirmed = await context.service.recordDecision({
      session: context.session,
      workItemId: first.id,
      sourceEventId: 'event-2',
      kind: 'constraint',
      content: '必须兼容 PostgreSQL。'
    });
    const proposed = await context.service.recordDecision({
      session: context.session,
      workItemId: first.id,
      sourceEventId: 'event-3',
      kind: 'preference',
      content: '可能使用向量检索。',
      confirmed: false
    });
    const related = await context.service.createWorkItem({
      session: context.session,
      sourceEventId: 'event-4',
      title: '扩展语义路由',
      goal: '扩展语义路由但保留数据库约束',
      parentWorkItemId: first.id,
      inheritedDecisionIds: [confirmed.id]
    });

    assert.deepEqual(related.inheritedDecisionIds, [confirmed.id]);
    assert.deepEqual(context.service.validDecisions(context.session.id, related.id).map((item) => item.id), [confirmed.id]);
    await assert.rejects(
      () => context.service.createWorkItem({
        session: context.session,
        sourceEventId: 'event-5',
        title: '非法继承',
        goal: '不能继承未确认决策',
        inheritedDecisionIds: [proposed.id]
      }),
      /Only confirmed Session decisions/
    );
  } finally {
    await context.cleanup();
  }
});

test('a child WorkItem answer overrides an inherited answer without changing the parent', async () => {
  const context = await fixture();
  try {
    const parent = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const sourceEvent = (id: string): CollaborationEvent => ({
      id, sessionId: context.session.id, type: 'user_message', toAgentIds: [], content: '回答问题',
      metadata: createMetadata('chat_message', {}), actor: { type: 'user', id: context.session.ownerId },
      createdAt: new Date().toISOString()
    });
    const [oldAnswer] = await context.service.recordConfirmedDecisions({
      session: context.session, workItemId: parent.id, sourceEvent: sourceEvent('parent-answer'),
      decisions: [{ kind: 'requirement', question: '是否支持 CSV？', answer: '不支持', content: '不支持 CSV' }]
    });
    const child = await context.service.createWorkItem({
      session: context.session, sourceEventId: 'child-created', title: '导出变更', goal: '修改导出范围',
      parentWorkItemId: parent.id, inheritedDecisionIds: [oldAnswer.id]
    });
    const [newAnswer] = await context.service.recordConfirmedDecisions({
      session: context.session, workItemId: child.id, sourceEvent: sourceEvent('child-answer'),
      decisions: [{ kind: 'requirement', question: '是否支持 CSV?', answer: '支持', content: '支持 CSV' }]
    });
    assert.deepEqual(context.service.validDecisions(context.session.id, child.id).map((item) => item.id), [newAnswer.id]);
    assert.deepEqual(context.service.validDecisions(context.session.id, parent.id).map((item) => item.id), [oldAnswer.id]);
  } finally { await context.cleanup(); }
});

test('Brief confirmation checkpoints authoritative decisions and its audit event idempotently', async () => {
  const context = await fixture();
  try {
    const workItem = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const sourceEvent: CollaborationEvent = {
      id: 'brief-confirmation-event',
      sessionId: context.session.id,
      type: 'user_confirmation_resolved',
      toAgentIds: [],
      content: 'Brief confirmed',
      metadata: createMetadata('system_notice', { relatedBriefId: 'brief-1' }),
      actor: { type: 'user', id: 'user-1' },
      createdAt: '2026-08-07T00:00:03.000Z'
    };
    const input = {
      session: context.session,
      workItemId: workItem.id,
      sourceEvent,
      decisions: [
        { kind: 'requirement' as const, content: 'Preserve user decisions' },
        { kind: 'constraint' as const, content: 'PostgreSQL compatible' },
        { kind: 'approval' as const, content: 'Brief version 1 confirmed' }
      ]
    };

    const first = await context.service.recordConfirmedDecisions(input);
    const replay = await context.service.recordConfirmedDecisions(input);

    assert.equal(first.length, 3);
    assert.deepEqual(replay.map((item) => item.id), first.map((item) => item.id));
    assert.equal(context.service.listDecisions(context.session.id).length, 3);
    assert.equal(context.session.decisionLedgerRevision, 1);
    const outbox = context.persistence.getCollection<Array<Record<string, unknown>>>('eventOutbox', []);
    assert.equal(outbox.filter((item) => item.id === 'outbox:brief-confirmation-event').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('revision answers survive restart, replay and later answer replacement', async () => {
  const context = await fixture();
  try {
    const workItem = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const event = (id: string): CollaborationEvent => ({
      id, sessionId: context.session.id, type: 'user_message', toAgentIds: [],
      content: '修订任务契约', metadata: createMetadata('chat_message', {}),
      actor: { type: 'user', id: context.session.ownerId }, createdAt: new Date().toISOString()
    });
    const firstInput = {
      session: context.session, workItemId: workItem.id, sourceEvent: event('revision-1'),
      decisions: [{ kind: 'requirement' as const, question: '是否支持 CSV？', answer: '不支持',
        content: '问题：是否支持 CSV？\n回答：不支持' }]
    };
    const first = await context.service.recordConfirmedDecisions(firstInput);
    const replay = await context.service.recordConfirmedDecisions(firstInput);
    assert.equal(replay[0]?.id, first[0]?.id);

    const restored = new ContextManagementService(context.persistence);
    assert.equal(restored.validDecisions(context.session.id, workItem.id)[0]?.answer, '不支持');
    const replacement = await restored.recordConfirmedDecisions({
      ...firstInput, sourceEvent: event('revision-6'),
      decisions: [{ kind: 'requirement', question: '是否支持 CSV?', answer: '支持 CSV',
        content: '问题：是否支持 CSV?\n回答：支持 CSV' }]
    });
    assert.equal(replacement[0]?.supersedesDecisionId, first[0]?.id);
    assert.equal(restored.validDecisions(context.session.id, workItem.id)[0]?.answer, '支持 CSV');
    assert.equal(restored.listDecisions(context.session.id).find((item) => item.id === first[0]?.id)?.status, 'superseded');
  } finally { await context.cleanup(); }
});

test('intent snapshots are minimal, revisioned and routing ingress is idempotent', async () => {
  const context = await fixture();
  try {
    const item = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    await context.service.recordDecision({
      session: context.session,
      workItemId: item.id,
      sourceEventId: 'event-2',
      kind: 'requirement',
      content: '保留用户决策。'
    });
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session,
      sourceEventId: 'event-3',
      currentMessage: '继续，并保留之前的决定',
      latestEventSeq: 3,
      pendingConfirmationContext: {
        confirmationId: 'confirmation-resume-1',
        reason: 'coordinator_routing_needs_user_decision',
        content: '请选择下一步。',
        options: [{ key: 'resume', label: '继续执行' }],
        createdAt: '2026-08-11T00:00:00.000Z'
      }
    });
    const first = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-3',
      idempotencyKey: 'session-1:event-3:intent-v2.1',
      rolloutMode: 'shadow'
    });
    const duplicate = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-3',
      idempotencyKey: 'session-1:event-3:intent-v2.1',
      rolloutMode: 'shadow'
    });

    assert.equal(snapshot.activeWorkItemId, item.id);
    assert.equal(snapshot.currentMessage, '继续，并保留之前的决定');
    assert.equal(snapshot.pendingConfirmationContext?.confirmationId, 'confirmation-resume-1');
    assert.equal(snapshot.validDecisionIds.length, 1);
    assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal('chatHistory' in snapshot, false);
    assert.equal(first.id, duplicate.id);
    assert.equal(context.service.listRoutingRecords(context.session.id).length, 1);
  } finally {
    await context.cleanup();
  }
});

test('routing claims enforce persisted sessionSeq ordering and terminal idempotency', async () => {
  const context = await fixture();
  try {
    await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const first = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-routing-1',
      idempotencyKey: 'routing-claim-1',
      rolloutMode: 'enforce_all_current_epoch'
    });
    const second = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-routing-2',
      idempotencyKey: 'routing-claim-2',
      rolloutMode: 'enforce_all_current_epoch'
    });

    const secondBlocked = await context.service.claimIntentRouting(
      context.session.id, second.id, 'snapshot-2', 'worker-2'
    );
    assert.equal(secondBlocked.state, 'blocked');
    assert.equal(secondBlocked.blockingRouting?.id, first.id);
    const firstClaim = await context.service.claimIntentRouting(
      context.session.id, first.id, 'snapshot-1', 'worker-1', 60_000
    );
    assert.equal(firstClaim.state, 'claimed');
    assert.equal(firstClaim.routing.status, 'CLASSIFYING');
    assert.equal(firstClaim.routing.leaseOwner, 'worker-1');
    assert.ok(firstClaim.routing.reasonCodes.includes('ROUTING_CLAIMED'));
    assert.equal((await context.service.claimIntentRouting(
      context.session.id, first.id, 'snapshot-1', 'worker-2'
    )).state, 'blocked');
    await context.service.updateRoutingRecord(context.session.id, first.id, {
      leaseExpiresAt: '2026-01-01T00:00:00.000Z'
    });
    const reclaimed = await context.service.claimIntentRouting(
      context.session.id, first.id, 'snapshot-1', 'worker-2'
    );
    assert.equal(reclaimed.state, 'claimed');
    assert.equal(reclaimed.routing.leaseOwner, 'worker-2');
    assert.equal(reclaimed.routing.retryCount, 1);
    assert.ok(reclaimed.routing.reasonCodes.includes('ROUTING_LEASE_RECLAIMED'));
    assert.equal((await context.service.claimIntentRouting(
      context.session.id, second.id, 'snapshot-2', 'worker-2'
    )).state, 'blocked');

    await context.service.updateRoutingRecord(context.session.id, first.id, { status: 'VALIDATING' });
    await context.service.updateRoutingRecord(context.session.id, first.id, { status: 'ROUTED' });
    const secondClaim = await context.service.claimIntentRouting(
      context.session.id, second.id, 'snapshot-2', 'worker-2'
    );
    assert.equal(secondClaim.state, 'claimed');
    await context.service.updateRoutingRecord(context.session.id, second.id, { status: 'VALIDATING' });
    await context.service.updateRoutingRecord(context.session.id, second.id, { status: 'ROUTED' });
    assert.equal((await context.service.claimIntentRouting(
      context.session.id, second.id, 'snapshot-2', 'worker-2'
    )).state, 'terminal');
  } finally {
    await context.cleanup();
  }
});

test('route application atomically checkpoints explicit user constraints in the Decision Ledger', async () => {
  const context = await fixture();
  try {
    const workItem = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session,
      sourceEventId: 'event-constraint',
      currentMessage: '必须保持 PostgreSQL 兼容。',
      latestEventSeq: 1
    });
    const routing = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-constraint',
      idempotencyKey: 'route-constraint',
      rolloutMode: 'enforce_all_current_epoch'
    });
    const followUp: SessionFollowUpMessage = {
      id: 'follow-up-constraint',
      sourceEventId: 'event-constraint',
      content: '必须保持 PostgreSQL 兼容。',
      mentionedAgentIds: [],
      handlingPlan: {
        intent: 'constraint', priority: 'high', shouldPause: false,
        affectedTaskIds: [], affectedAgentIds: [], requiresBriefRevision: false,
        requiresUserConfirmation: false, coordinatorInstruction: 'apply constraint'
      },
      workItemId: workItem.id,
      routingId: routing.id,
      status: 'queued',
      queuedAt: '2026-08-07T00:00:00.000Z'
    };
    await context.service.saveFollowUp(context.session.id, followUp);
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'SNAPSHOT_READY', snapshotId: snapshot.id });
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'CLASSIFYING' });
    const decision: IntentRoutingDecisionV2 = {
      dialogueAct: 'constraint', scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed',
      requestedAction: 'continue_active_work_item', selectedWorkItemId: workItem.id,
      selectedDecisionIds: [], selectedArtifactIds: [], goalSegments: [], missingFields: [],
      ambiguityReasons: [], reasonCodes: ['USER_CONSTRAINT'], riskLevel: 'low'
    };
    const validation: IntentRoutingValidation = {
      schemaValid: true, referencesValid: true, transitionValid: true,
      snapshotCurrent: true, safeToApply: true, serverConfidence: 1, errors: []
    };
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'VALIDATING', decision, validation });

    await context.service.applyIntentRoute({
      session: context.session,
      routingId: routing.id,
      snapshotId: snapshot.id,
      followUpId: followUp.id,
      decision,
      validation
    });
    await context.service.applyIntentRoute({
      session: context.session,
      routingId: routing.id,
      snapshotId: snapshot.id,
      followUpId: followUp.id,
      decision,
      validation
    });

    const decisions = context.service.listDecisions(context.session.id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.kind, 'constraint');
    assert.equal(decisions[0]?.content, followUp.content);
    assert.equal(decisions[0]?.workItemId, workItem.id);
    assert.equal(decisions[0]?.confirmedBy?.id, context.session.ownerId);
    assert.equal(context.session.decisionLedgerRevision, 1);
  } finally {
    await context.cleanup();
  }
});

test('route application creates a related WorkItem with only explicit inheritance and is idempotent', async () => {
  const context = await fixture();
  try {
    const first = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    await context.persistence.setCollection('workItemsBySession', {
      [context.session.id]: [{ ...first, inheritedArtifactIds: ['artifact-1'] }]
    });
    const confirmed = await context.service.recordDecision({
      session: context.session,
      workItemId: first.id,
      sourceEventId: 'event-2',
      kind: 'constraint',
      content: '保留 PostgreSQL 兼容性。'
    });
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session,
      sourceEventId: 'event-3',
      currentMessage: '增加一个相关的路由审计任务',
      latestEventSeq: 3
    });
    const routing = await context.service.createRoutingRecord({
      session: context.session,
      sourceEventId: 'event-3',
      idempotencyKey: 'route-related',
      rolloutMode: 'enforce_all_current_epoch'
    });
    const followUp: SessionFollowUpMessage = {
      id: 'follow-up-1',
      sourceEventId: 'event-3',
      content: '增加一个相关的路由审计任务',
      mentionedAgentIds: [],
      handlingPlan: {
        intent: 'clarification', priority: 'normal', shouldPause: false,
        affectedTaskIds: [], affectedAgentIds: [], requiresBriefRevision: false,
        requiresUserConfirmation: false, coordinatorInstruction: 'pending'
      },
      workItemId: first.id,
      routingId: routing.id,
      status: 'queued',
      queuedAt: '2026-08-07T00:00:00.000Z'
    };
    await context.service.saveFollowUp(context.session.id, followUp);
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'SNAPSHOT_READY', snapshotId: snapshot.id });
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'CLASSIFYING' });
    const decision: IntentRoutingDecisionV2 = {
      dialogueAct: 'command', scopeRelation: 'related_new_requirement', contextPolicy: 'inherit_selected',
      requestedAction: 'create_related_work_item', selectedWorkItemId: first.id,
      selectedDecisionIds: [confirmed.id], selectedArtifactIds: ['artifact-1'],
      goalSegments: ['增加路由审计'], missingFields: [], ambiguityReasons: [], reasonCodes: ['TEST'], riskLevel: 'low'
    };
    const validation: IntentRoutingValidation = {
      schemaValid: true, referencesValid: true, transitionValid: true,
      snapshotCurrent: true, safeToApply: true, serverConfidence: 1, errors: []
    };
    await context.service.updateRoutingRecord(context.session.id, routing.id, {
      status: 'VALIDATING', decision, validation
    });

    const applied = await context.service.applyIntentRoute({
      session: context.session, routingId: routing.id, snapshotId: snapshot.id,
      followUpId: followUp.id, decision, validation,
      handlingPlan: { ...followUp.handlingPlan, coordinatorInstruction: 'apply related route' },
      routeEventFactory: (route) => ({
        id: 'event-route-applied',
        sessionId: context.session.id,
        type: 'work_item_created',
        toAgentIds: [],
        content: `Created ${route.workItem.title}`,
        metadata: createMetadata('system_notice', { routingId: route.routing.id, workItemId: route.workItem.id }),
        actor: { type: 'system', id: 'system' },
        createdAt: '2026-08-07T00:00:02.000Z'
      })
    });
    const replay = await context.service.applyIntentRoute({
      session: context.session, routingId: routing.id, snapshotId: snapshot.id,
      followUpId: followUp.id, decision, validation
    });

    assert.equal(applied.createdWorkItem, true);
    assert.equal(applied.workItem.parentWorkItemId, first.id);
    assert.deepEqual(applied.workItem.inheritedDecisionIds, [confirmed.id]);
    assert.deepEqual(applied.workItem.inheritedArtifactIds, ['artifact-1']);
    assert.equal(applied.followUp.handlingPlan.coordinatorInstruction, 'apply related route');
    assert.equal(applied.committedEvent?.id, 'event-route-applied');
    assert.equal(replay.workItem.id, applied.workItem.id);
    assert.equal(replay.deferredActivation, applied.deferredActivation);
    if (applied.deferredActivation) {
      assert.equal(context.session.activeWorkItemId, first.id);
      assert.equal(context.persistence.getCollection<SessionDetail[]>('sessions', [])[0]?.activeWorkItemId, first.id);
    }
    assert.equal(context.service.listWorkItems(context.session.id).length, 2);
    const persistedEvents = context.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    const outbox = context.persistence.getCollection<Array<Record<string, unknown>>>('eventOutbox', []);
    assert.equal(persistedEvents[context.session.id]?.filter((event) => event.id === 'event-route-applied').length, 1);
    assert.equal(outbox.filter((item) => item.id === 'outbox:event-route-applied').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('application policy rejects inherited context on independent routes even with forged safeToApply', async () => {
  const context = await fixture();
  try {
    const first = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const decisionRecord = await context.service.recordDecision({
      session: context.session, workItemId: first.id, sourceEventId: 'event-2',
      kind: 'requirement', content: '旧任务决策'
    });
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session, sourceEventId: 'event-3', currentMessage: '讨论完全独立的新问题', latestEventSeq: 3
    });
    const routing = await context.service.createRoutingRecord({
      session: context.session, sourceEventId: 'event-3', idempotencyKey: 'route-independent', rolloutMode: 'enforce_all_current_epoch'
    });
    const followUp: SessionFollowUpMessage = {
      id: 'follow-up-independent', sourceEventId: 'event-3', content: '讨论完全独立的新问题',
      mentionedAgentIds: [], handlingPlan: {
        intent: 'clarification', priority: 'normal', shouldPause: false, affectedTaskIds: [], affectedAgentIds: [],
        requiresBriefRevision: false, requiresUserConfirmation: false, coordinatorInstruction: 'pending'
      }, workItemId: first.id, routingId: routing.id, status: 'queued', queuedAt: '2026-08-07T00:00:00.000Z'
    };
    await context.service.saveFollowUp(context.session.id, followUp);
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'SNAPSHOT_READY', snapshotId: snapshot.id });
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'CLASSIFYING' });
    const decision: IntentRoutingDecisionV2 = {
      dialogueAct: 'question', scopeRelation: 'independent_new_requirement', contextPolicy: 'clean_task_context',
      requestedAction: 'create_independent_work_item', selectedWorkItemId: first.id,
      selectedDecisionIds: [decisionRecord.id], selectedArtifactIds: ['old-artifact'], goalSegments: ['独立问题'],
      missingFields: [], ambiguityReasons: [], reasonCodes: ['TEST'], riskLevel: 'low'
    };
    const validation: IntentRoutingValidation = {
      schemaValid: true, referencesValid: true, transitionValid: true,
      snapshotCurrent: true, safeToApply: true, serverConfidence: 1, errors: []
    };
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'VALIDATING', decision, validation });

    await assert.rejects(context.service.applyIntentRoute({
      session: context.session, routingId: routing.id, snapshotId: snapshot.id,
      followUpId: followUp.id, decision, validation
    }), /INTENT_POLICY_REJECTED/);
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
    const applied = await context.service.applyIntentRoute({
      session: context.session, routingId: routing.id, snapshotId: snapshot.id,
      followUpId: followUp.id, decision: { ...decision, selectedDecisionIds: [], selectedArtifactIds: [] }, validation
    });

    assert.equal(applied.workItem.parentWorkItemId, undefined);
    assert.deepEqual(applied.workItem.inheritedDecisionIds, []);
    assert.deepEqual(applied.workItem.inheritedArtifactIds, []);
  } finally {
    await context.cleanup();
  }
});

test('WorkItem context slices exclude unrelated records and retain explicit inheritance', async () => {
  const context = await fixture();
  try {
    const first = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    // Inherited artifacts must be real Session artifacts, so the one this slice
    // claims to inherit is registered the way the artifacts service registers it.
    await context.persistence.setCollection('artifacts', {
      artifactsById: {
        'artifact-inherited': {
          id: 'artifact-inherited', sessionId: context.session.id, workItemId: first.id, type: 'json', title: 'inherited'
        }
      },
      artifactIdsBySession: { [context.session.id]: ['artifact-inherited'] }
    });
    const second = await context.service.createWorkItem({
      session: context.session,
      sourceEventId: 'event-2',
      title: 'Related work',
      goal: 'Related work',
      parentWorkItemId: first.id,
      inheritedDecisionIds: [],
      inheritedArtifactIds: ['artifact-inherited'],
      activate: false
    });
    const tasks = [
      { id: 'task-first', sessionId: context.session.id, workItemId: first.id, title: 'old', status: 'completed' },
      { id: 'task-second', sessionId: context.session.id, workItemId: second.id, title: 'new', status: 'pending' }
    ] as any;
    const events = [
      { id: 'event-first', sessionId: context.session.id, workItemId: first.id, type: 'agent_message', content: 'old' },
      { id: 'event-second', sessionId: context.session.id, workItemId: second.id, type: 'agent_message', content: 'new' }
    ] as any;
    const memories = [
      { id: 'memory-first', sessionId: context.session.id, workItemId: first.id, scope: 'session', content: 'old', confidence: 1 },
      { id: 'memory-second', sessionId: context.session.id, workItemId: second.id, scope: 'session', content: 'new', confidence: 1 }
    ] as any;
    const artifacts = [
      { id: 'artifact-first', sessionId: context.session.id, workItemId: first.id, type: 'json', title: 'old' },
      { id: 'artifact-second', sessionId: context.session.id, workItemId: second.id, type: 'json', title: 'new' },
      { id: 'artifact-inherited', sessionId: context.session.id, workItemId: first.id, type: 'json', title: 'inherited' }
    ] as any;
    const slice = context.service.buildWorkItemContextSlice({
      session: context.session, workItemId: second.id, tasks, events, memories, artifacts
    });
    assert.deepEqual(slice.tasks.map((item) => item.id), ['task-second']);
    assert.deepEqual(slice.events.map((item) => item.id), ['event-second']);
    assert.deepEqual(slice.memories.map((item) => item.id), ['memory-second']);
    assert.deepEqual(slice.artifacts.map((item) => item.id).sort(), ['artifact-inherited', 'artifact-second']);
  } finally {
    await context.cleanup();
  }
});

function userMessage(sessionId: string, index: number, content: string, workItemId?: string): CollaborationEvent {
  return {
    id: `history-${index}`,
    sessionId,
    ...(workItemId ? { workItemId } : {}),
    type: 'user_message',
    toAgentIds: [],
    content,
    metadata: createMetadata('chat_message', { text: content }),
    actor: { type: 'user', id: 'user-1' },
    createdAt: new Date(Date.UTC(2026, 7, 7, 0, 0, index)).toISOString()
  };
}

test('intent snapshots bound recent dialogue and candidates instead of injecting whole history', async () => {
  const context = await fixture();
  try {
    const active = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    for (let index = 0; index < 100; index += 1) {
      await context.service.createWorkItem({
        session: context.session,
        sourceEventId: `event-history-${index}`,
        title: `历史需求 ${index}`,
        goal: `历史需求目标 ${index}`,
        activate: false
      });
    }
    const history = Array.from({ length: 1_000 }, (_, index) =>
      userMessage(context.session.id, index, `第 ${index} 条历史消息`, active.id));
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: history });

    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session,
      sourceEventId: 'history-999',
      currentMessage: '继续刚才那个需求',
      latestEventSeq: history.length
    });

    assert.ok(snapshot.bounds, 'snapshot must declare its own bounds');
    assert.equal(snapshot.candidateWorkItemIds.length, snapshot.bounds.candidateWorkItemLimit);
    assert.equal(snapshot.bounds.totalCandidateWorkItems, 101);
    assert.equal(snapshot.bounds.omittedCandidateWorkItems, 101 - snapshot.bounds.candidateWorkItemLimit);
    assert.ok(
      (snapshot.recentRelevantMessages?.length ?? 0) <= snapshot.bounds.recentMessageLimit,
      `recent dialogue must stay within the declared cap, got ${snapshot.recentRelevantMessages?.length}`
    );
    assert.ok((snapshot.recentRelevantMessages?.length ?? 0) > 0, 'recent dialogue must not be empty');
    assert.equal(snapshot.bounds.omittedRecentMessages, 1_000 - (snapshot.recentRelevantMessages?.length ?? 0));
    assert.deepEqual(
      snapshot.recentRelevantMessages?.map((item) => item.eventId),
      history.slice(-(snapshot.recentRelevantMessages?.length ?? 0)).map((item) => item.id),
      'recent dialogue keeps the newest messages, oldest first'
    );
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('第 0 条历史消息'), false, 'the oldest history must not reach the classifier');
    assert.ok(serialized.length < 40_000, `snapshot payload must not grow with history, got ${serialized.length}`);
  } finally {
    await context.cleanup();
  }
});

test('intent snapshots keep the server-resolved reply target and @ constraint', async () => {
  const context = await fixture();
  try {
    await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const long = '排查'.repeat(2_000);
    const events = [
      userMessage(context.session.id, 1, '第一条历史消息'),
      userMessage(context.session.id, 2, long)
    ];
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: events });

    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session,
      sourceEventId: 'event-reply',
      currentMessage: '@质量 这个也一起看下',
      latestEventSeq: events.length,
      mentionedAgentIds: ['agent-quality', 'agent-quality'],
      replyToEventId: 'history-2'
    });

    assert.deepEqual(snapshot.mentionedAgentIds, ['agent-quality'], '@ targets are deduplicated but preserved');
    assert.equal(snapshot.replyToEventId, 'history-2');
    assert.equal(snapshot.replyToMessage?.eventId, 'history-2');
    assert.equal(snapshot.replyToMessage?.role, 'user');
    assert.equal(snapshot.replyToMessage?.truncated, true, 'a long reply target is excerpted, not inlined whole');
    assert.ok(
      (snapshot.replyToMessage?.content.length ?? 0) <= (snapshot.bounds?.messageCharLimit ?? 0),
      'the reply excerpt respects the declared char cap'
    );

    await assert.rejects(
      () => context.service.buildIntentSnapshot({
        session: context.session,
        sourceEventId: 'event-reply-2',
        currentMessage: '回复一条不存在的消息',
        latestEventSeq: events.length,
        replyToEventId: 'event-from-another-session'
      }),
      /REPLY_TARGET_OUTSIDE_SESSION/
    );
  } finally {
    await context.cleanup();
  }
});

test('snapshot hash covers the new target fields so a changed @ target is not reusable', async () => {
  const context = await fixture();
  try {
    await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const events = [userMessage(context.session.id, 1, '第一条历史消息')];
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: events });
    const base = {
      session: context.session,
      sourceEventId: 'event-hash',
      currentMessage: '同一句话',
      latestEventSeq: events.length
    };

    const withoutMention = await context.service.buildIntentSnapshot(base);
    const withMention = await context.service.buildIntentSnapshot({
      ...base,
      mentionedAgentIds: ['agent-quality']
    });
    const withReply = await context.service.buildIntentSnapshot({
      ...base,
      mentionedAgentIds: ['agent-quality'],
      replyToEventId: 'history-1'
    });

    assert.notEqual(withoutMention.snapshotHash, withMention.snapshotHash, '@ targets must change the hash');
    assert.notEqual(withMention.snapshotHash, withReply.snapshotHash, 'a reply target must change the hash');
    assert.equal(
      context.service.isSnapshotCurrent(context.session, withReply, events.length),
      true,
      'target fields alone must not make a fresh snapshot stale'
    );
  } finally {
    await context.cleanup();
  }
});

test('an early requirement among a hundred is recalled into the bounded candidates with its source', async () => {
  const context = await fixture();
  try {
    const early = await context.service.createWorkItem({
      session: context.session, sourceEventId: 'event-early', title: '登录页改版',
      goal: '重做登录页并支持手机号验证码登录', activate: false
    });
    for (let index = 0; index < 99; index += 1) {
      await context.service.createWorkItem({
        session: context.session, sourceEventId: `event-${index}`, title: `其它需求 ${index}`,
        goal: `与登录无关的功能 ${index}`, activate: index === 98
      });
    }
    // A thousand old messages plus a versioned checkpoint for the early requirement:
    // the recall must point at the checkpoint reference, not drag bodies along.
    const history = Array.from({ length: 1_000 }, (_, index) =>
      userMessage(context.session.id, index, `第 ${index} 条历史消息`, early.id));
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: history });
    const checkpoints = new SummaryCheckpointStore(context.persistence);
    const committed = await checkpoints.commit({
      sessionId: context.session.id, workItemId: early.id, phase: 'task_execution', coveredEventSeq: 900,
      workItemRevision: 1, decisionLedgerRevision: 0, policyVersion: 'summary-checkpoint-v2',
      summaryMemory: {
        goal: '重做登录页', currentState: 'COMPLETED', confirmedFacts: ['一段很长很长的摘要正文'.repeat(50)],
        completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: []
      },
      sourceEventIds: ['history-899'], sourceArtifactIds: [], sourceMemoryIds: [], sourceDecisionIds: []
    });
    assert.equal(committed.status, 'committed');
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session, sourceEventId: 'event-ask', latestEventSeq: history.length,
      currentMessage: '之前那个登录页改版，手机号验证码的方案还在吗'
    });

    assert.ok(snapshot.candidateWorkItemIds.includes(early.id), 'the early requirement must be recallable');
    assert.ok(snapshot.candidateWorkItemIds.length <= (snapshot.bounds?.candidateWorkItemLimit ?? 0), 'recall stays bounded');
    assert.equal(snapshot.recall?.availability, 'ok');
    assert.equal(snapshot.recall?.needsClarification, false);
    assert.equal(snapshot.recall?.candidates[0]?.workItemId, early.id);
    assert.equal(snapshot.recall?.candidates[0]?.matchedBy, 'lexical');
    assert.equal(
      snapshot.recall?.candidates[0]?.latestCheckpointId,
      committed.status === 'committed' ? committed.record.checkpointId : undefined,
      'recall carries the checkpoint reference so the body can be read on demand'
    );
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('很长很长'), false, 'recall never inlines the checkpoint body');
    assert.ok(serialized.length < 40_000, `snapshot must stay bounded with 100 requirements and 1,000 messages, got ${serialized.length}`);
  } finally {
    await context.cleanup();
  }
});

test('two similar historical requirements are surfaced for clarification, not auto-selected', async () => {
  const context = await fixture();
  try {
    await context.service.ensureInitialWorkItem(context.session, 'event-1');
    const first = await context.service.createWorkItem({
      session: context.session, sourceEventId: 'event-a', title: '导出报表', goal: '支持 Excel 导出与分页', activate: false
    });
    const second = await context.service.createWorkItem({
      session: context.session, sourceEventId: 'event-b', title: '导出报表 v2', goal: '支持 CSV 与 Excel 导出', activate: false
    });
    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session, sourceEventId: 'event-ask', latestEventSeq: 0, currentMessage: '把导出报表那个继续做完'
    });
    assert.equal(snapshot.recall?.needsClarification, true);
    assert.equal(snapshot.recall?.clarificationReason, 'multiple_similar_candidates');
    const recalled = snapshot.recall?.candidates.map((item) => item.workItemId).sort();
    assert.deepEqual(recalled?.slice(0, 2), [first.id, second.id].sort());
  } finally {
    await context.cleanup();
  }
});

test('recall is scoped to the Session: another session\'s private memory is never a candidate', async () => {
  const context = await fixture();
  try {
    // Session-1 holds its own requirement and its own private memory.
    const own = await context.service.ensureInitialWorkItem(context.session, 'event-1');
    await context.service.recordDecision({
      session: context.session, workItemId: own.id, sourceEventId: 'event-own',
      kind: 'requirement', content: '本会话的私有决定：数据库使用 PostgreSQL'
    });

    // Session-2 (another chat with the same agentIds) holds the private
    // requirement that session-1's message lexically matches.
    const other: SessionDetail = { ...context.session, id: 'session-2', revision: 1, activeWorkItemId: undefined };
    await context.persistence.setCollection('sessions', [
      ...context.persistence.getCollection<SessionDetail[]>('sessions', []), other
    ]);
    const foreign = await context.service.createWorkItem({
      session: other, sourceEventId: 'event-foreign', title: '登录页改版',
      goal: '重做登录页并支持手机号验证码登录', activate: false
    });
    await context.service.recordDecision({
      session: other, workItemId: foreign.id, sourceEventId: 'event-foreign',
      kind: 'requirement', content: '另一会话的私有决定：验证码用短信通道'
    });

    const snapshot = await context.service.buildIntentSnapshot({
      session: context.session, sourceEventId: 'event-ask', latestEventSeq: 1,
      currentMessage: '之前那个登录页改版，手机号验证码的方案还在吗'
    });

    assert.equal(snapshot.recall?.availability, 'ok');
    assert.equal(
      snapshot.recall?.candidates.some((candidate) => candidate.workItemId === foreign.id),
      false,
      'a WorkItem from another Session must never enter the recall candidates'
    );
    assert.deepEqual(
      snapshot.recall?.candidates.map((candidate) => candidate.workItemId),
      [],
      'no_match is the honest answer instead of leaking the other session'
    );
    assert.equal(snapshot.recall?.needsClarification, true);
    assert.equal(snapshot.recall?.clarificationReason, 'no_match');
    assert.equal(
      snapshot.candidateWorkItemIds.includes(foreign.id), false,
      'candidate list stays inside the Session boundary'
    );
    assert.deepEqual(
      snapshot.validDecisions.filter((decision) => decision.content.includes('短信通道')),
      [],
      'another session\'s private decisions are not exposed as valid decisions'
    );
  } finally { await context.cleanup(); }
});

test('a new requirement cannot inherit an artifact that is not a real Session artifact', async () => {
  const context = await fixture();
  try {
    const parent = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const decision = await context.service.recordDecision({
      session: context.session,
      workItemId: parent.id,
      kind: 'requirement',
      content: '导出需包含退款明细',
      sourceEventId: 'event-1'
    });

    // Decisions are already guarded; artifacts were copied verbatim, so an id
    // from another Session (or a typo) could be presented as inherited evidence
    // for the new requirement.
    await assert.rejects(
      () => context.service.createWorkItem({
        session: context.session,
        sourceEventId: 'event-2',
        title: '独立需求',
        goal: '另一个导出',
        inheritedDecisionIds: [decision.id],
        inheritedArtifactIds: ['artifact-from-another-session']
      }),
      /artifact/i,
      'an unknown artifact id must be refused, not recorded as inherited evidence'
    );
  } finally {
    await context.cleanup();
  }
});

test('a real Session artifact can still be inherited explicitly', async () => {
  const context = await fixture();
  try {
    const parent = await context.service.ensureInitialWorkItem(context.session, 'initial');
    await context.persistence.setCollection('artifacts', {
      artifactsById: {
        'artifact-1': { id: 'artifact-1', sessionId: context.session.id, workItemId: parent.id, title: 'Report' }
      },
      artifactIdsBySession: { [context.session.id]: ['artifact-1'] }
    });

    const created = await context.service.createWorkItem({
      session: context.session,
      sourceEventId: 'event-2',
      title: '相关需求',
      goal: '在导出基础上加退款',
      parentWorkItemId: parent.id,
      inheritedArtifactIds: ['artifact-1']
    });

    assert.deepEqual(created.inheritedArtifactIds, ['artifact-1']);
  } finally {
    await context.cleanup();
  }
});

async function clarificationFixture() {
  const context = await fixture();
  const work = await context.service.ensureInitialWorkItem(context.session, 'initial');
  const route = await context.service.createRoutingRecord({ session: context.session, sourceEventId: 'question',
    idempotencyKey: 'clarify-route', rolloutMode: 'enforce_all_current_epoch' });
  const followUp: SessionFollowUpMessage = { id: 'clarify-followup', sourceEventId: 'question', content: '处理这个新问题',
    mentionedAgentIds: [], workItemId: work.id, routingId: route.id, status: 'queued', queuedAt: new Date().toISOString(),
    handlingPlan: { intent: 'clarification', priority: 'normal', shouldPause: false, affectedTaskIds: [], affectedAgentIds: [],
      requiresBriefRevision: false, requiresUserConfirmation: true, coordinatorInstruction: 'pending' } };
  await context.service.saveFollowUp(context.session.id, followUp);
  await context.service.updateRoutingRecord(context.session.id, route.id, { status: 'SNAPSHOT_READY' });
  await context.service.updateRoutingRecord(context.session.id, route.id, { status: 'CLASSIFYING' });
  const pending = await context.service.updateRoutingRecord(context.session.id, route.id, { status: 'CLARIFICATION_REQUIRED' });
  const card: CollaborationEvent = { id: 'card-event', sessionId: context.session.id, type: 'intent_clarification_required',
    content: '选择任务关系', toAgentIds: [], actor: { type: 'system', id: 'system' }, createdAt: new Date().toISOString(),
    metadata: createMetadata('confirmation_card', { confirmationId: 'card-1', routingId: route.id,
      routingRevision: pending.routingRevision, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      options: [{ key: 'continue_current' }, { key: 'related_new' }, { key: 'independent_new' }] }) };
  await context.persistence.setCollection('eventsBySession', { [context.session.id]: [card] });
  const snapshot = await context.service.buildIntentSnapshot({ session: context.session, sourceEventId: 'question',
    currentMessage: followUp.content, latestEventSeq: 1 });
  const input = { session: context.session, routingId: route.id, snapshotId: snapshot.id, followUpId: followUp.id,
    decision: { dialogueAct: 'command', scopeRelation: 'independent_new_requirement', contextPolicy: 'clean_task_context',
      requestedAction: 'create_independent_work_item', selectedWorkItemId: work.id, selectedDecisionIds: [], selectedArtifactIds: [],
      goalSegments: [followUp.content], missingFields: [], ambiguityReasons: [], reasonCodes: ['USER_CLARIFIED'], riskLevel: 'low'
    } as IntentRoutingDecisionV2,
    validation: { schemaValid: true, referencesValid: true, transitionValid: true, snapshotCurrent: true,
      safeToApply: true, serverConfidence: 1, errors: [] },
    clarification: { contractVersion: 'intent-clarify-v1' as const, confirmationId: 'card-1',
      expectedRoutingRevision: pending.routingRevision, choice: 'independent_new' as const, idempotencyKey: 'choice-1' } };
  return { ...context, input, card, initialOutboxCount: context.persistence.getCollection<unknown[]>('eventOutbox', []).length };
}

test('clarification transaction has one effect under replay and rejects opposite choices after restart', async () => {
  const context = await clarificationFixture();
  try {
    const restored = new ContextManagementService(context.persistence);
    const results = await Promise.all([context.service.applyIntentRoute(context.input), restored.applyIntentRoute(context.input)]);
    assert.equal(results[0].workItem.id, results[1].workItem.id);
    assert.equal(results.filter(item => item.idempotentReplay).length, 1);
    assert.equal(context.service.listWorkItems(context.session.id).length, 2);
    const events = context.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {})[context.session.id];
    assert.equal(events.filter(event => event.type === 'user_confirmation_resolved').length, 1);
    const outbox = context.persistence.getCollection<Array<{event: CollaborationEvent}>>('eventOutbox', []);
    assert.equal(outbox.length, context.initialOutboxCount + 1);
    assert.equal(results[0].routing.resolution?.choice, 'independent_new');
    await assert.rejects(restored.applyIntentRoute({ ...context.input, clarification: {
      ...context.input.clarification, choice: 'continue_current', idempotencyKey: 'opposite-choice'
    } }), /CLARIFICATION_CHOICE_CONFLICT/);
    await assert.rejects(restored.applyIntentRoute({ ...context.input, clarification: {
      ...context.input.clarification, choice: 'continue_current'
    } }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  } finally { await context.cleanup(); }
});

test('clarification rejects wrong binding, stale revision and expiry without changing projections', async () => {
  const context = await clarificationFixture();
  try {
    await assert.rejects(context.service.applyIntentRoute({ ...context.input, clarification: {
      ...context.input.clarification, choice: 'continue_current'
    } }), /CLARIFICATION_PLAN_MISMATCH/);
    await assert.rejects(context.service.applyIntentRoute({ ...context.input, clarification: {
      ...context.input.clarification, confirmationId: 'unrelated-card'
    } }), /CLARIFICATION_CONFIRMATION_MISMATCH/);
    await assert.rejects(context.service.applyIntentRoute({ ...context.input, clarification: {
      ...context.input.clarification, expectedRoutingRevision: 999
    } }), /CLARIFICATION_REVISION_CONFLICT/);
    context.card.metadata.payload!.expiresAt = new Date(0).toISOString();
    await context.persistence.setCollection('eventsBySession', { [context.session.id]: [context.card] });
    await assert.rejects(context.service.applyIntentRoute(context.input), /CLARIFICATION_EXPIRED/);
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].resolution, undefined);
  } finally { await context.cleanup(); }
});

test('clarification commit failure rolls back receipt, work item and outbox together', async () => {
  const context = await clarificationFixture();
  try {
    await assert.rejects(context.service.applyIntentRoute({ ...context.input,
      routeEventFactory: () => { throw new Error('injected commit failure'); }
    }), /injected commit failure/);
    assert.equal(context.service.listWorkItems(context.session.id).length, 1);
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].status, 'CLARIFICATION_REQUIRED');
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].resolution, undefined);
    assert.equal(context.persistence.getCollection<unknown[]>('eventOutbox', []).length, context.initialOutboxCount);
    const applied = await context.service.applyIntentRoute(context.input);
    assert.equal(applied.routing.status, 'ROUTED');
  } finally { await context.cleanup(); }
});

test('classification attempt budget and deadline survive reconstruction and concurrent reservation', async () => {
  const context = await fixture();
  try {
    const routing = await context.service.createRoutingRecord({ session: context.session, sourceEventId: 'message',
      idempotencyKey: 'attempt-budget', rolloutMode: 'enforce_all_current_epoch' });
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'SNAPSHOT_READY' });
    await context.service.updateRoutingRecord(context.session.id, routing.id, { status: 'CLASSIFYING' });
    const restored = new ContextManagementService(context.persistence);
    const reserved = await Promise.all([context.service.reserveIntentClassificationAttempt(context.session.id, routing.id, 'attempt-1', 'classification'),
      restored.reserveIntentClassificationAttempt(context.session.id, routing.id, 'attempt-2', 'schema_repair')]);
    assert.deepEqual(reserved.sort(), [1, 2]);
    const deadline = context.service.listRoutingRecords(context.session.id)[0].classificationDeadlineAt;
    assert.equal(await new ContextManagementService(context.persistence).reserveIntentClassificationAttempt(context.session.id, routing.id, 'attempt-3', 'rebuild'), undefined);
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].classificationDeadlineAt, deadline);
    assert.equal(context.service.listRoutingRecords(context.session.id)[0].attemptLog?.length, 2);
  } finally { await context.cleanup(); }
});


test('a corrected timeout supersedes the old Decision and the next snapshot excludes the old value', async () => {
  const context = await fixture();
  try {
    const work = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const old = await context.service.recordDecision({ session: context.session, workItemId: work.id,
      sourceEventId: 'timeout-old', kind: 'constraint', content: '超时必须为 10 分钟' });
    const corrected = await context.service.recordDecision({ session: context.session, workItemId: work.id,
      sourceEventId: 'timeout-correction', kind: 'correction', content: '超时改为 20 分钟',
      supersedesDecisionId: old.id, expectedDecisionRevision: old.revision });
    const snapshot = await context.service.buildIntentSnapshot({ session: context.session, sourceEventId: 'next',
      currentMessage: '按照最新超时限制处理', latestEventSeq: 1 });
    assert.deepEqual(snapshot.validDecisionIds, [corrected.id]);
    assert.equal(context.service.listDecisions(context.session.id).find(item => item.id === old.id)?.status, 'superseded');
    const replay = await context.service.recordDecision({ session: context.session, workItemId: work.id,
      sourceEventId: 'timeout-correction', kind: 'correction', content: '超时改为 20 分钟',
      supersedesDecisionId: old.id, expectedDecisionRevision: old.revision });
    assert.equal(replay.id, corrected.id);
    assert.equal(context.service.listDecisions(context.session.id).length, 2);
  } finally { await context.cleanup(); }
});

test('concurrent corrections to the same Decision revision have one winner', async () => {
  const context = await fixture();
  try {
    const work = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const old = await context.service.recordDecision({ session: context.session, workItemId: work.id,
      sourceEventId: 'timeout-old', kind: 'constraint', content: '超时为 10 分钟' });
    const second = new ContextManagementService(context.persistence);
    const results = await Promise.allSettled([context.service, second].map((service, index) => service.recordDecision({
      session: context.session, workItemId: work.id, sourceEventId: `correction-${index}`, kind: 'correction',
      content: `超时改为 ${20 + index} 分钟`, supersedesDecisionId: old.id, expectedDecisionRevision: 1 })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.match(String(rejected.reason), /DECISION_REVISION_CONFLICT/);
    assert.equal(context.service.validDecisions(context.session.id, work.id).length, 1);
  } finally { await context.cleanup(); }
});

test('inherited constraint corrections remain local through repeated replacement', async () => {
  const context = await fixture();
  try {
    const parent = await context.service.ensureInitialWorkItem(context.session, 'initial');
    const old = await context.service.recordDecision({ session: context.session, workItemId: parent.id,
      sourceEventId: 'timeout-old', kind: 'constraint', content: '超时为 10 分钟' });
    const child = await context.service.createWorkItem({ session: context.session, sourceEventId: 'child',
      title: '子任务', goal: '子任务', parentWorkItemId: parent.id, inheritedDecisionIds: [old.id] });
    const sibling = await context.service.createWorkItem({ session: context.session, sourceEventId: 'sibling',
      title: '同级任务', goal: '同级任务', parentWorkItemId: parent.id, inheritedDecisionIds: [old.id] });
    const override = await context.service.recordDecision({ session: context.session, workItemId: child.id,
      sourceEventId: 'override', kind: 'correction', content: '本任务超时为 20 分钟', supersedesDecisionId: old.id, expectedDecisionRevision: 1 });
    const next = await context.service.recordDecision({ session: context.session, workItemId: child.id,
      sourceEventId: 'next-override', kind: 'correction', content: '本任务超时为 30 分钟', supersedesDecisionId: override.id, expectedDecisionRevision: 1 });
    assert.equal(next.overridesDecisionId, old.id);
    assert.deepEqual(context.service.validDecisions(context.session.id, child.id).map(item => item.id), [next.id]);
    assert.deepEqual(context.service.validDecisions(context.session.id, parent.id).map(item => item.id), [old.id]);
    assert.deepEqual(context.service.validDecisions(context.session.id, sibling.id).map(item => item.id), [old.id]);
    assert.equal(context.service.listDecisions(context.session.id).find(item => item.id === old.id)?.status, 'confirmed');
  } finally { await context.cleanup(); }
});
