import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { LegacyWorkItemMigrationService } from './legacy-workitem-migration.service.js';

function session(): SessionDetail {
  return {
    id: 'session-legacy', dataEpoch: 'epoch-test', workspaceId: 'workspace-legacy',
    title: 'Legacy', originalInput: 'Legacy requirement', status: 'COMPLETED'
  } as SessionDetail;
}

test('reports bootstrap and ownership counts without writing, then applies idempotently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-legacy-migration-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(directory, 'state.v3.json') });
  await persistence.initialize();
  const current = session();
  await persistence.setCollection('sessions', [current]);
  await persistence.setCollection('eventsBySession', { [current.id]: [{ id: 'event-1' }] });
  await persistence.setCollection('artifacts', { artifactsById: { 'artifact-1': { id: 'artifact-1', sessionId: current.id } } });

  try {
    const service = new LegacyWorkItemMigrationService(persistence);
    const report = service.report([current]);
    assert.equal(report.mode, 'report');
    assert.equal(report.sessions[0]?.requiresBootstrap, true);
    assert.equal(report.plannedRecordCount, 2);
    const beforeEvent = (persistence.snapshotState().eventsBySession as Record<string, Array<Record<string, unknown>>>)[current.id][0];
    assert.equal(beforeEvent?.workItemId, undefined);

    const workItem = {
      id: 'work-item-legacy', sessionId: current.id, title: 'Legacy', goal: current.originalInput,
      status: 'COMPLETED', revision: 1, createdFromEventId: 'legacy-bootstrap',
      inheritedDecisionIds: [], inheritedArtifactIds: [], createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z'
    };
    await persistence.setCollection('workItemsBySession', { [current.id]: [workItem] });
    current.activeWorkItemId = workItem.id;
    const applied = await service.apply([current]);
    assert.equal(applied.migratedRecordCount, 2);
    assert.equal((persistence.snapshotState().eventsBySession as Record<string, Array<Record<string, unknown>>>)[current.id][0].workItemId, workItem.id);
    assert.equal((persistence.snapshotState().artifacts as { artifactsById: Record<string, Record<string, unknown>> }).artifactsById['artifact-1'].workItemId, workItem.id);
    const replay = await service.apply([current]);
    assert.equal(replay.migratedRecordCount, 0);
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
