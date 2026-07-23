import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { assertWorkspacePathWithinRoot } from './workspace-symlink-guard.js';
import { readServerLocalFile } from './workspace-read-file.js';
import { statServerLocalFile } from './workspace-stat-file.js';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';

const baseRevision = {
  id: 'revision-120-base',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

const nextRevision = {
  id: 'revision-120-next',
  observedAt: '2026-07-12T00:00:01.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

async function withEscapingSymlink(
  fn: (ctx: { root: string; outside: string; symlinkRelative: string }) => Promise<void>
) {
  const parent = await mkdtemp(join(tmpdir(), 'workspace-t120-'));
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'leaked\n');
  const linkPath = join(root, 'escape.txt');
  try {
    await symlink(join(outside, 'secret.txt'), linkPath, 'file');
  } catch (error) {
    if (platform() === 'win32') {
      // Windows requires elevated privileges for file symlinks; skip if unavailable.
      await rm(parent, { recursive: true, force: true });
      return { skipped: true as const };
    }
    throw error;
  }
  try {
    await fn({ root, outside, symlinkRelative: 'escape.txt' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  return { skipped: false as const };
}

test('assertWorkspacePathWithinRoot resolves normal paths inside root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t120-in-'));
  try {
    await writeFile(join(root, 'ok.txt'), 'ok');
    const resolved = await assertWorkspacePathWithinRoot(root, 'ok.txt');
    const rootReal = await realpath(root);
    assert.equal(resolved.startsWith(rootReal), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertWorkspacePathWithinRoot rejects symlink escaping the workspace root', async () => {
  const result = await withEscapingSymlink(async ({ root, symlinkRelative }) => {
    await assert.rejects(
      assertWorkspacePathWithinRoot(root, symlinkRelative),
      /符号链接|路径越界/
    );
  });
  if (result.skipped) {
    // Windows without symlink privilege — still exercised on Linux CI.
    assert.ok(true);
  }
});

test('readServerLocalFile rejects a symlink whose target lives outside the workspace root', async () => {
  const result = await withEscapingSymlink(async ({ root, symlinkRelative }) => {
    await assert.rejects(
      readServerLocalFile({
        rootPath: root,
        revision: baseRevision,
        input: { path: symlinkRelative }
      }),
      /符号链接|路径越界|escape/i
    );
  });
  if (result.skipped) assert.ok(true);
});

test('statServerLocalFile rejects a symlink whose target lives outside the workspace root', async () => {
  const result = await withEscapingSymlink(async ({ root, symlinkRelative }) => {
    await assert.rejects(
      statServerLocalFile({
        rootPath: root,
        revision: baseRevision,
        input: { path: symlinkRelative }
      }),
      /符号链接|路径越界|escape/i
    );
  });
  if (result.skipped) assert.ok(true);
});

test('applyServerLocalChangeSet refuses to write through a symlink escaping the workspace root', async () => {
  const result = await withEscapingSymlink(async ({ root, symlinkRelative }) => {
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000120',
      baseRevision,
      changes: [
        {
          operation: 'update',
          path: symlinkRelative,
          content: 'overwritten\n',
          encoding: 'utf-8',
          expectedHash: sha256('leaked\n')
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
      /符号链接|路径越界|escape/i
    );
  });
  if (result.skipped) assert.ok(true);
});
