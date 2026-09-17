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

test('independent route creates a clean WorkItem even when the model selects old context', async () => {
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

    const applied = await context.service.applyIntentRoute({
      session: context.session, routingId: routing.id, snapshotId: snapshot.id,
      followUpId: followUp.id, decision, validation
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
    for (let index = 0; index < 40; index += 1) {
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
    assert.equal(snapshot.bounds.totalCandidateWorkItems, 41);
    assert.equal(snapshot.bounds.omittedCandidateWorkItems, 41 - snapshot.bounds.candidateWorkItemLimit);
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
