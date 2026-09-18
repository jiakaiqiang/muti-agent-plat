import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, rm, symlink, writeFile, mkdir, realpath } from 'node:fs/promises';
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

/** Which kind of real escaping link the fixture managed to create. */
type EscapingLinkCarrier = 'file-symlink' | 'junction';

type EscapingLinkResult =
  | { skipped: true; reason: string }
  | { skipped: false; carrier: EscapingLinkCarrier; symlinkRelative: string };

async function withEscapingSymlink(
  fn: (ctx: { root: string; outside: string; symlinkRelative: string }) => Promise<void>
): Promise<EscapingLinkResult> {
  const parent = await mkdtemp(join(tmpdir(), 'workspace-t120-'));
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'leaked\n');
  const linkPath = join(root, 'escape.txt');
  let symlinkRelative = 'escape.txt';
  let carrier: EscapingLinkCarrier | undefined;
  try {
    await symlink(join(outside, 'secret.txt'), linkPath, 'file');
    // Trust lstat, not symlink()'s return value: some Windows/sandbox
    // environments report success while creating a regular file instead
    // (isSymbolicLink() === false, readlink throws EINVAL) or creating nothing
    // at all (lstat throws ENOENT).
    if ((await lstat(linkPath)).isSymbolicLink()) carrier = 'file-symlink';
  } catch {
    carrier = undefined;
  }
  if (!carrier && platform() === 'win32') {
    // Fall back to a directory junction. It needs no elevation on Windows and
    // is a genuine reparse point — lstat reports isSymbolicLink() === true and
    // realpath resolves it to `outside` — so the escaping path (a file *through*
    // the junction) must be rejected exactly like an escaping file symlink.
    const junctionPath = join(root, 'escape-dir');
    try {
      await symlink(outside, junctionPath, 'junction');
      if ((await lstat(junctionPath)).isSymbolicLink()) {
        carrier = 'junction';
        symlinkRelative = 'escape-dir/secret.txt';
      }
    } catch {
      carrier = undefined;
    }
  }
  if (!carrier) {
    // No real escaping link available on this host; Linux CI still exercises
    // the file-symlink fixture end to end. Reported as a real skip so the
    // coverage gap is visible in the skipped count instead of hiding behind a
    // passing assertion.
    await rm(parent, { recursive: true, force: true });
    return {
      skipped: true,
      reason: 'no real escaping link could be created on this host (symlink privilege unavailable and junction fallback failed)'
    };
  }
  // Remove the reparse point before the recursive cleanup so removal can never
  // traverse it into the outside tree.
  const reparsePoint = carrier === 'junction' ? join(root, 'escape-dir') : linkPath;
  try {
    await fn({ root, outside, symlinkRelative });
  } finally {
    await rm(reparsePoint, { recursive: false, force: true }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
  return { skipped: false, carrier, symlinkRelative };
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

test('assertWorkspacePathWithinRoot rejects symlink escaping the workspace root', async (t) => {
  const result = await withEscapingSymlink(async ({ root, symlinkRelative }) => {
    await assert.rejects(
      assertWorkspacePathWithinRoot(root, symlinkRelative),
      /符号链接|路径越界/
    );
  });
  if (result.skipped) {
    t.skip(result.reason);
    return;
  }
  t.diagnostic(`escaping link carrier: ${result.carrier}, path: ${result.symlinkRelative}`);
});

test('readServerLocalFile rejects a symlink whose target lives outside the workspace root', async (t) => {
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
  if (result.skipped) {
    t.skip(result.reason);
    return;
  }
  t.diagnostic(`escaping link carrier: ${result.carrier}, path: ${result.symlinkRelative}`);
});

test('statServerLocalFile rejects a symlink whose target lives outside the workspace root', async (t) => {
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
  if (result.skipped) {
    t.skip(result.reason);
    return;
  }
  t.diagnostic(`escaping link carrier: ${result.carrier}, path: ${result.symlinkRelative}`);
});

test('applyServerLocalChangeSet refuses to write through a symlink escaping the workspace root', async (t) => {
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
  if (result.skipped) {
    t.skip(result.reason);
    return;
  }
  t.diagnostic(`escaping link carrier: ${result.carrier}, path: ${result.symlinkRelative}`);
});
