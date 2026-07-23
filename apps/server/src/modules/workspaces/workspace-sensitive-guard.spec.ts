import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import {
  assertWorkspaceWriteAllowed,
  evaluateWorkspaceSensitivePaths,
  isWorkspaceSensitivePath
} from './workspace-sensitive-guard.js';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';

const baseRevision = {
  id: 'revision-119-base',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

const nextRevision = {
  id: 'revision-119-next',
  observedAt: '2026-07-12T00:00:01.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t119-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('isWorkspaceSensitivePath covers .npmrc / .aws / .ssh / .docker and other credential paths', () => {
  assert.equal(isWorkspaceSensitivePath('.npmrc'), true);
  assert.equal(isWorkspaceSensitivePath('.aws/credentials'), true);
  assert.equal(isWorkspaceSensitivePath('.ssh/id_rsa'), true);
  assert.equal(isWorkspaceSensitivePath('.docker/config.json'), true);
  assert.equal(isWorkspaceSensitivePath('.kube/config'), true);
  assert.equal(isWorkspaceSensitivePath('.gnupg/private-keys.txt'), true);
  assert.equal(isWorkspaceSensitivePath('apps/server/.env.production'), true);
  assert.equal(isWorkspaceSensitivePath('src/index.ts'), false);
  assert.equal(isWorkspaceSensitivePath('README.md'), false);
});

test('evaluateWorkspaceSensitivePaths returns per-path allow/deny reasons', () => {
  const result = evaluateWorkspaceSensitivePaths([
    'src/app.ts',
    '.npmrc',
    'infra/.aws/config',
    'docs/README.md'
  ]);
  assert.deepEqual(result.allowed, ['src/app.ts', 'docs/README.md']);
  assert.equal(result.denied.length, 2);
  const npmrc = result.denied.find((d) => d.path === '.npmrc');
  const aws = result.denied.find((d) => d.path === 'infra/.aws/config');
  assert.ok(npmrc);
  assert.match(npmrc!.reason, /sensitive/i);
  assert.ok(aws);
  assert.match(aws!.reason, /sensitive/i);
});

test('assertWorkspaceWriteAllowed throws for any sensitive path in a ChangeSet-shaped list', () => {
  assert.throws(
    () =>
      assertWorkspaceWriteAllowed([
        { operation: 'create', path: '.aws/credentials', content: 'x', encoding: 'utf-8' },
        {
          operation: 'update',
          path: 'src/app.ts',
          content: 'y',
          encoding: 'utf-8',
          expectedHash: sha256('y')
        }
      ]),
    /sensitive/i
  );
  assert.throws(
    () =>
      assertWorkspaceWriteAllowed([
        {
          operation: 'move',
          fromPath: 'src/a.ts',
          toPath: '.ssh/id_rsa',
          expectedHash: sha256('a')
        }
      ]),
    /sensitive/i
  );
  assert.doesNotThrow(() =>
    assertWorkspaceWriteAllowed([
      { operation: 'create', path: 'src/new.ts', content: 'n', encoding: 'utf-8' },
      { operation: 'delete', path: 'src/old.ts', expectedHash: sha256('o') }
    ])
  );
});

test('applyServerLocalChangeSet refuses to write to a sensitive path even without conflicts', async () => {
  await withTempRoot(async (root) => {
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000119',
      baseRevision,
      changes: [
        { operation: 'create', path: '.npmrc', content: '//registry:token=leak\n', encoding: 'utf-8' }
      ],
      createdAt: '2026-07-12T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    await assert.rejects(
      applyServerLocalChangeSet({
        rootPath: root,
        currentRevision: baseRevision,
        nextRevision,
        changeSet
      }),
      /sensitive/i
    );
  });
});

test('applyServerLocalChangeSet refuses to move a file onto a sensitive destination', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'note.txt'), 'plain content\n');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000119',
      baseRevision,
      changes: [
        {
          operation: 'move',
          fromPath: 'note.txt',
          toPath: '.aws/credentials',
          expectedHash: sha256('plain content\n')
        }
      ],
      createdAt: '2026-07-12T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    await assert.rejects(
      applyServerLocalChangeSet({
        rootPath: root,
        currentRevision: baseRevision,
        nextRevision,
        changeSet
      }),
      /sensitive/i
    );
  });
});
