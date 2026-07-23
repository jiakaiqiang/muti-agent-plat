import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';

const baseRevision = {
  id: 'revision-123-base',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

test('applyServerLocalChangeSet serializes concurrent writes to the same path (last writer wins over on-disk state, not mid-flight state)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t123-'));
  try {
    const initial = 'const v = 0;\n';
    await writeFile(join(root, 'a.ts'), initial);

    const firstContent = 'const v = 1;\n';
    const firstChangeSet = {
      id: '00000000-0000-4000-8000-000000000123-a',
      baseRevision,
      changes: [
        {
          operation: 'update',
          path: 'a.ts',
          content: firstContent,
          encoding: 'utf-8',
          expectedHash: sha256(initial)
        }
      ],
      createdAt: '2026-07-12T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    const secondContent = 'const v = 2;\n';
    const secondChangeSet = {
      id: '00000000-0000-4000-8000-000000000123-b',
      baseRevision,
      changes: [
        {
          operation: 'update',
          path: 'a.ts',
          content: secondContent,
          encoding: 'utf-8',
          expectedHash: sha256(initial)
        }
      ],
      createdAt: '2026-07-12T00:00:00.001Z'
    } satisfies WorkspaceChangeSet;

    const [firstResult, secondResult] = await Promise.all([
      applyServerLocalChangeSet({
        rootPath: root,
        currentRevision: baseRevision,
        changeSet: firstChangeSet
      }),
      applyServerLocalChangeSet({
        rootPath: root,
        currentRevision: baseRevision,
        changeSet: secondChangeSet
      })
    ]);

    // Whichever change set runs first commits its write.
    // The second one, if it arrives after the first commit, will hash-conflict
    // (because on-disk contents changed) and be rejected — that's the safety
    // net serialization gives us. If serialization were broken, both would
    // pass baseHash validation and clobber each other.
    const succeeded = [firstResult, secondResult].filter((r) => r.ok);
    const conflicted = [firstResult, secondResult].filter((r) => !r.ok);
    assert.equal(succeeded.length, 1, 'exactly one apply succeeds');
    assert.equal(conflicted.length, 1, 'the other apply hash-conflicts');

    const finalContent = await readFile(join(root, 'a.ts'), 'utf8');
    assert.ok(
      finalContent === firstContent || finalContent === secondContent,
      'final content matches whichever change set won the race'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
