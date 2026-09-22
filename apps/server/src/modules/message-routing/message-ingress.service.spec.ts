import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollaborationEvent, SessionDetail, UserMessageHandlingPlan } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { MessageIngressService } from './message-ingress.service.js';

const handlingPlan: UserMessageHandlingPlan = {
  intent: 'knowledge_input',
  requirementRelation: 'continuation',
  failedExecutionAction: 'none',
  priority: 'normal',
  shouldPause: false,
  affectedTaskIds: [],
  affectedAgentIds: [],
  requiresBriefRevision: false,
  requiresUserConfirmation: false,
  coordinatorInstruction: ''
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-message-ingress-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(directory, 'state.v3.json') });
  await persistence.initialize();
  const now = '2026-09-16T00:00:00.000Z';
  const session: SessionDetail = {
    id: 'session-1',
    dataEpoch: 'epoch-1',
    revision: 1,
    decisionLedgerRevision: 0,
    title: '统一消息意图',
    originalInput: '统一消息意图',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    participatingAgentIds: ['agent-quality'],
    createdAt: now,
    updatedAt: now
  };
  await persistence.setCollection('sessions', [session]);
  const context = new ContextManagementService(persistence);
  const accepted: CollaborationEvent[] = [];
  const events = {
    createDraft: (input: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      type: input.type,
      content: input.content,
      toAgentIds: input.toAgentIds ?? [],
      actor: { type: 'user', id: 'user-1' },
      metadata: input.metadata ?? { schemaVersion: '0.1', payload: {} },
      createdAt: new Date().toISOString()
    }) as unknown as CollaborationEvent,
    acceptCommitted: (event: CollaborationEvent) => {
      accepted.push(event);
      return true;
    },
    list: (sessionId: string) => accepted.filter((item) => item.sessionId === sessionId)
  };
  const agents = {
    getForSurface: (id: string) => ({ id, key: id })
  };
  const service = new MessageIngressService(
    context,
    events as never,
    agents as never
  );
  return {
    persistence,
    context,
    service,
    session,
    accepted,
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('message ingress persists the explicit reply target alongside mentions', async () => {
  const harness = await fixture();
  try {
    const first = await harness.service.commit({
      session: harness.session,
      content: '先做登录页',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow'
    });

    const second = await harness.service.commit({
      session: harness.session,
      content: '这条是回复上面那条',
      mentionedAgentIds: ['agent-quality'],
      handlingPlan,
      routingMode: 'shadow',
      replyToEventId: first.event.id
    });

    assert.equal(second.followUp.replyToEventId, first.event.id);
    assert.equal(second.followUp.mentionedAgentIds[0], 'agent-quality');
    assert.equal(second.event.metadata.payload?.replyToEventId, first.event.id);

    const persisted = harness.context.listFollowUps(harness.session.id)
      .find((item) => item.id === second.followUp.id);
    assert.equal(persisted?.replyToEventId, first.event.id);
  } finally {
    await harness.cleanup();
  }
});

test('message ingress rejects a reply target outside the Session', async () => {
  const harness = await fixture();
  try {
    await assert.rejects(
      harness.service.commit({
        session: harness.session,
        content: '引用别的会话',
        mentionedAgentIds: [],
        handlingPlan,
        routingMode: 'shadow',
        replyToEventId: crypto.randomUUID()
      }),
      (error: { response?: { code?: string } }) => error.response?.code === 'REPLY_TARGET_NOT_IN_SESSION'
    );
  } finally {
    await harness.cleanup();
  }
});

test('idempotent replay preserves the recorded reply target', async () => {
  const harness = await fixture();
  try {
    const anchor = await harness.service.commit({
      session: harness.session,
      content: '锚点消息',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow'
    });
    const key = 'client-message-1';
    const first = await harness.service.commit({
      session: harness.session,
      content: '带幂等键的回复',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow',
      messageIdempotencyKey: key,
      replyToEventId: anchor.event.id
    });
    const replay = await harness.service.commit({
      session: harness.session,
      content: '带幂等键的回复',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow',
      messageIdempotencyKey: key,
      replyToEventId: anchor.event.id
    });

    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.followUp.id, first.followUp.id);
    assert.equal(replay.followUp.replyToEventId, anchor.event.id);
  } finally {
    await harness.cleanup();
  }
});

test('a budget-exhaustion recovery message atomically creates a clean related WorkItem', async () => {
  const harness = await fixture();
  try {
    const original = await harness.service.commit({
      session: harness.session,
      content: '一次性完成所有模块',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow'
    });
    const replacement = await harness.service.commit({
      session: harness.session,
      content: '只实现登录接口，并补齐接口测试',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'shadow',
      budgetExhaustionConfirmationId: 'budget-card-1'
    });

    assert.equal(replacement.idempotentReplay, false);
    assert.equal(replacement.routing.forcedWorkItemId, replacement.workItem.id);
    assert.equal(replacement.workItem.parentWorkItemId, original.workItem.id);
    assert.deepEqual(replacement.workItem.inheritedDecisionIds, []);
    assert.deepEqual(replacement.workItem.inheritedArtifactIds, []);
    assert.equal(harness.context.getWorkItem(harness.session.id, original.workItem.id).status, 'WAITING_USER');
    assert.equal(harness.session.activeWorkItemId, replacement.workItem.id);
    assert.ok(harness.accepted.some((event) =>
      event.type === 'user_confirmation_resolved' &&
      event.metadata.payload?.confirmationId === 'budget-card-1'
    ));
  } finally {
    await harness.cleanup();
  }
});

test('message ingress persists attachment metadata references without file bytes', async () => {
  const harness = await fixture();
  try {
    const result = await harness.service.commit({
      session: harness.session,
      content: '',
      mentionedAgentIds: [],
      attachmentRefs: [{
        id: 'attachment-1', sessionId: harness.session.id, kind: 'file', fileName: 'notes.txt',
        mimeType: 'text/plain', sizeBytes: 12, uploadStatus: 'ready', createdAt: '2026-09-22T00:00:00.000Z'
      }],
      handlingPlan,
      routingMode: 'shadow'
    });
    assert.equal(result.event.content, '');
    const payload = result.event.metadata.payload as { attachmentRefs?: Array<{ id: string }>; bytes?: unknown } | undefined;
    assert.equal(payload?.attachmentRefs?.[0]?.id, 'attachment-1');
    assert.equal(result.followUp.attachmentRefs?.[0]?.fileName, 'notes.txt');
    assert.equal('bytes' in (payload ?? {}), false);
  } finally {
    await harness.cleanup();
  }
});

test('message ingress persists structured Skill, Agent and resolved routing snapshots', async () => {
  const harness = await fixture();
  try {
    const result = await harness.service.commit({
      session: harness.session,
      content: '请由质量 Agent 执行这个 Skill',
      mentionedAgentIds: ['agent-quality'],
      directives: {
        skill: { id: 'skill-1', key: 'qa', name: '质量检查', revision: 2 },
        agents: [{ id: 'agent-quality', key: 'quality', name: '质量 Agent' }],
        attachments: []
      },
      routing: {
        mode: 'single',
        reason: 'skill_agent_semantically_matched',
        candidateAgentIds: ['agent-quality'],
        distributionAgentIds: [],
        resolvedAgentId: 'agent-quality',
        resolvedAgent: { id: 'agent-quality', key: 'quality', name: '质量 Agent' },
        skill: { id: 'skill-1', key: 'qa', name: '质量检查', revision: 2 }
      },
      handlingPlan,
      routingMode: 'shadow'
    });
    const payload = result.event.metadata.payload as {
      directives?: { skill?: { id: string }; agents?: Array<{ id: string }> };
      routing?: { resolvedAgentId?: string };
    };
    assert.equal(payload.directives?.skill?.id, 'skill-1');
    assert.equal(payload.directives?.agents?.[0]?.id, 'agent-quality');
    assert.equal(payload.routing?.resolvedAgentId, 'agent-quality');
    assert.equal(result.followUp.skillRef?.revision, 2);
    assert.equal(result.followUp.agentRefs?.[0]?.id, 'agent-quality');
    assert.equal(result.followUp.routing?.mode, 'single');
  } finally {
    await harness.cleanup();
  }
});

test('a preference message atomically requests confirmation and replay does not create a second card', async () => {
  const harness = await fixture();
  try {
    const input = {
      session: harness.session,
      content: '请记住：以后偏好简洁报告。',
      mentionedAgentIds: [],
      handlingPlan,
      routingMode: 'enforce_new_sessions' as const,
      messageIdempotencyKey: 'preference-message-1',
      preferenceConfirmation: {}
    };
    const first = await harness.service.commit(input);
    const replay = await harness.service.commit(input);
    assert.equal(replay.idempotentReplay, true);
    const persisted = harness.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    const cards = persisted[harness.session.id].filter((item) =>
      item.type === 'user_confirmation_requested' && item.metadata.payload?.reason === 'confirm_memory_write'
    );
    assert.equal(cards.length, 1);
    const candidate = (cards[0].metadata.payload as {
      candidate?: { sourceEventId?: string; content?: string };
    }).candidate;
    assert.equal(candidate?.sourceEventId, first.event.id);
    assert.equal(candidate?.content, input.content);
    assert.equal(harness.accepted.filter((item) => item.type === 'user_confirmation_requested').length, 1);
  } finally {
    await harness.cleanup();
  }
});
