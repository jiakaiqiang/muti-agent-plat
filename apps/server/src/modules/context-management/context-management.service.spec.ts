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
      latestEventSeq: 3
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
    assert.equal(snapshot.validDecisionIds.length, 1);
    assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal('chatHistory' in snapshot, false);
    assert.equal(first.id, duplicate.id);
    assert.equal(context.service.listRoutingRecords(context.session.id).length, 1);
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
