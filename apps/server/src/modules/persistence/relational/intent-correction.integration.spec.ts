import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { IntentRouteRevision, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence.service.js';
import { ContextManagementService } from '../../context-management/context-management.service.js';
import { IntentCorrectionService } from '../../message-routing/intent-correction.service.js';
import { LogicalOperationStore } from '../../runtimes/logical-operation-store.js';

const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL;

test('PostgreSQL correction race, immutable versions, restart hold and deletion agree across independent connections',
  { skip: !databaseUrl }, async () => {
    const first = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
    const second = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
    const restored = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
    const deleted = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl });
    const sessionId = randomUUID();
    try {
      await first.initialize();
      const now = new Date().toISOString();
      const session: SessionDetail = { id: sessionId, dataEpoch: first.currentDataEpoch(), title: '纠错并发测试',
        originalInput: '实现登录', status: 'EXECUTING', ownerId: 'test-user', revision: 1, decisionLedgerRevision: 0,
        workspaceId: `test-workspace-${sessionId}`, tokenUsed: 0, participatingAgentIds: [], createdAt: now, updatedAt: now };
      await first.mutateCollections(['sessions'], draft => { ((draft.sessions ??= []) as SessionDetail[]).push(session); });
      const context = new ContextManagementService(first);
      const work = await context.ensureInitialWorkItem(session, randomUUID());
      const route = await context.createRoutingRecord({ session, sourceEventId: randomUUID(), idempotencyKey: randomUUID(), rolloutMode: 'enforce_all_current_epoch' });
      await second.initialize();
      const input = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision ?? 1,
        idempotencyKey: randomUUID(), instruction: '不要改登录业务，只补充超时约束。', targetWorkItemId: work.id,
        supersedesDecisionId: null, expectedDecisionRevision: null };
      const one = new IntentCorrectionService(first), two = new IntentCorrectionService(second);
      const results = await Promise.all([
        one.accept(sessionId, route.id, session.ownerId, input), two.accept(sessionId, route.id, session.ownerId, input)
      ]);
      assert.equal(results[0].correction.id, results[1].correction.id);
      assert.equal(results.filter(result => result.idempotentReplay).length, 1);
      await assert.rejects(first.mutateCollections(['intentRouteRevisionsBySession'], draft => {
        (draft.intentRouteRevisionsBySession as Record<string, IntentRouteRevision[]>)[sessionId][0].authorizationState = 'validated';
      }), /INTENT_RECORD_IMMUTABLE/);
      await restored.initialize();
      assert.equal(new IntentCorrectionService(restored).history(sessionId, route.id)[0].authorizationState, 'unknown');
      await assert.rejects(new LogicalOperationStore(restored).begin({ id: randomUUID(), sessionId, workItemId: work.id, phase: 'task_execution' }), /INTENT_DISPATCH_HELD/);
      await first.deleteSessionData(sessionId);
      await two.reconcileStop(results[0].correction);
      await deleted.initialize();
      assert.equal(new IntentCorrectionService(deleted).history(sessionId, route.id).length, 0);
      assert.equal(new IntentCorrectionService(deleted).list(sessionId, route.id).length, 0);
    } finally {
      await first.deleteSessionData(sessionId).catch(() => undefined);
      await first.onModuleDestroy(); await second.onModuleDestroy(); await restored.onModuleDestroy(); await deleted.onModuleDestroy();
    }
  });
