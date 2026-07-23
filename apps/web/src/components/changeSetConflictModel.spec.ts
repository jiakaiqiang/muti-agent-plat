import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { FileHash, WorkspaceChangeSet, WorkspaceConflictError } from '@agent-cluster/shared';
import { WORKSPACE_BASE_HASH_MISMATCH } from '@agent-cluster/shared';
import { buildChangeSetConflictModel } from './changeSetConflictModel';

function hash(value: string): FileHash {
  return { algorithm: 'sha256', value };
}

const baseRevision = { id: 'rev-base', observedAt: '2026-07-12T00:00:00.000Z' };
const actualRevision = { id: 'rev-actual', observedAt: '2026-07-12T00:00:05.000Z' };

const changeSet: WorkspaceChangeSet = {
  id: 'cs-1',
  baseRevision,
  changes: [
    { operation: 'create', path: 'src/new.ts', content: 'x', encoding: 'utf-8' },
    { operation: 'update', path: 'src/app.ts', content: 'x', encoding: 'utf-8', expectedHash: hash('aaa') },
    { operation: 'delete', path: 'src/old.ts', expectedHash: hash('bbb') }
  ],
  createdAt: '2026-07-12T00:00:00.000Z'
};

const conflicts: WorkspaceConflictError[] = [
  {
    code: WORKSPACE_BASE_HASH_MISMATCH,
    message: 'File hash changed since ChangeSet was prepared: src/app.ts',
    changeSetId: 'cs-1',
    operation: 'update',
    path: 'src/app.ts',
    baseHash: hash('aaa'),
    actualHash: hash('ccc'),
    actualRevision
  }
];

test('buildChangeSetConflictModel marks conflicting rows as non-writable', () => {
  const model = buildChangeSetConflictModel({ changeSet, conflicts });
  assert.equal(model.hasConflicts, true);
  assert.equal(model.rows.length, 3);
  const appRow = model.rows.find((r) => r.path === 'src/app.ts');
  assert.ok(appRow);
  assert.equal(appRow!.writable, false);
  assert.equal(appRow!.conflictCode, WORKSPACE_BASE_HASH_MISMATCH);
  assert.match(appRow!.conflictMessage!, /src\/app\.ts/);
  const newRow = model.rows.find((r) => r.path === 'src/new.ts');
  assert.equal(newRow!.writable, true);
  const oldRow = model.rows.find((r) => r.path === 'src/old.ts');
  assert.equal(oldRow!.writable, true);
});

test('buildChangeSetConflictModel returns hasConflicts:false when conflicts empty', () => {
  const model = buildChangeSetConflictModel({ changeSet, conflicts: [] });
  assert.equal(model.hasConflicts, false);
  for (const row of model.rows) assert.equal(row.writable, true);
});

test('buildChangeSetConflictModel matches conflicts by fromPath for move operations', () => {
  const moveChangeSet: WorkspaceChangeSet = {
    id: 'cs-2',
    baseRevision,
    changes: [
      { operation: 'move', fromPath: 'src/from.ts', toPath: 'src/to.ts', expectedHash: hash('ddd') }
    ],
    createdAt: '2026-07-12T00:00:00.000Z'
  };
  const moveConflicts: WorkspaceConflictError[] = [
    {
      code: WORKSPACE_BASE_HASH_MISMATCH,
      message: 'Target file no longer exists: src/from.ts',
      changeSetId: 'cs-2',
      operation: 'move',
      path: 'src/from.ts',
      baseHash: hash('ddd'),
      actualRevision
    }
  ];
  const model = buildChangeSetConflictModel({ changeSet: moveChangeSet, conflicts: moveConflicts });
  assert.equal(model.rows[0].writable, false);
  assert.equal(model.rows[0].path, 'src/from.ts');
  assert.equal(model.rows[0].targetPath, 'src/to.ts');
});
