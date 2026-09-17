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
