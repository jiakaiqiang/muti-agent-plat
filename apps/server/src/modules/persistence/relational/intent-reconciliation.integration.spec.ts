import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { PersistenceService } from '../persistence.service.js';
import { approvedRetryState } from '../../message-routing/intent-retry.fixture.js';
import { IntentReconciliationService } from '../../message-routing/intent-reconciliation.service.js';
import { RECONCILIATIONS } from '../../message-routing/intent-reconciliation-state.js';

const configuredUrl = process.env.RELATIONAL_TEST_DATABASE_URL;

test('R9a PostgreSQL disposable database: concurrent decisions, atomic rollback, restart and immutable audit',
  { skip: !configuredUrl, timeout: 60000 }, async () => {
    // The supplied URL contributes credentials only. Never open the application database.
    const adminUrl = new URL(configuredUrl!); adminUrl.pathname = '/postgres';
    const database = `agent_cluster_r9a_${process.pid}_${Date.now()}`;
    assert.match(database, /^agent_cluster_r9a_\d+_\d+$/); assert.notEqual(database, 'agent_cluster');
    const isolatedUrl = new URL(adminUrl); isolatedUrl.pathname = `/${database}`;
    const admin = new Pool({ connectionString: adminUrl.toString() });
    const stores: PersistenceService[] = []; let created = false;
    try {
      await admin.query(`create database "${database}"`); created = true;
      const first = new PersistenceService({ backend: 'postgres', databaseUrl: isolatedUrl.toString() }); stores.push(first); await first.initialize();
      const state: any = approvedRetryState();
      const epoch = first.currentDataEpoch();
      // Replace the fixture epoch throughout its linked immutable proofs before inserting any row.
      const seeded: any = JSON.parse(JSON.stringify(state).replaceAll('"epoch"', JSON.stringify(epoch)));
      await first.mutateCollections(Object.keys(seeded), draft => Object.assign(draft, seeded));
      const binding = seeded.sessions[0].activeRecoveryCheckpoint.retryBinding;
      await first.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
        draft.intentPlanStepsBySession.session[0].retryReceipts = [{ binding, processId: 'previous-worker', status: 'running' }];
      });
      await first.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
        draft.intentPlanStepsBySession.session[0].retryReceipts[0].status = 'reconciliation_required';
      });
      const service = new IntentReconciliationService(first), view = (await service.list('session', 'user'))[0];
      const second = new PersistenceService({ backend: 'postgres', databaseUrl: isolatedUrl.toString() }); stores.push(second); await second.initialize();
      const input = { expectedCaseRevision: view.record.revision, expectedSessionRevision: view.sessionRevision,
        action: 'confirm_completed', idempotencyKey: 'pg-one' };
      const replies = await Promise.all([service.decide('session', view.record.id, 'user', input),
        new IntentReconciliationService(second).decide('session', view.record.id, 'user', input)]);
      assert.equal(replies.filter(row => row.idempotentReplay).length, 1);
      await assert.rejects(first.mutateCollections([RECONCILIATIONS], (draft: any) => {
        draft[RECONCILIATIONS].session[0].decisions[0].actorId = 'forged';
      }), /RECORD_CONFLICT/);
      const restored = new PersistenceService({ backend: 'postgres', databaseUrl: isolatedUrl.toString() }); stores.push(restored); await restored.initialize();
      assert.equal((await new IntentReconciliationService(restored).decide('session', view.record.id, 'user', input)).idempotentReplay, true);
      assert.equal(restored.getCollection<any[]>('sessions', [])[0].status, 'WAIT_USER_DECISION');
      assert.equal(restored.getCollection<any>('tasksBySession', {}).session[0].status, 'completed');
    } finally {
      for (const store of stores) await store.onModuleDestroy();
      try { if (created) await admin.query(`drop database "${database}" with (force)`); }
      finally { await admin.end(); }
    }
  });
