import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLargeWorkspaceFixture, LARGE_FIXTURE_FILE_COUNT } from './build-large-workspace-fixture.js';

test('buildLargeWorkspaceFixture materializes at least 1000 files across generated/src/rag/memory/tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-fixture-t127-'));
  try {
    const result = await buildLargeWorkspaceFixture(root);
    assert.ok(result.totalFiles >= LARGE_FIXTURE_FILE_COUNT, `expected >= ${LARGE_FIXTURE_FILE_COUNT} files`);
    for (const key of ['generated', 'src', 'rag', 'memory', 'tools'] as const) {
      const info = await stat(join(root, key));
      assert.equal(info.isDirectory(), true, `${key} directory exists`);
      const entries = await readdir(join(root, key));
      assert.ok(entries.length > 0, `${key} is non-empty`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildLargeWorkspaceFixture puts source files under src/ and generated artifacts under generated/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-fixture-t127-'));
  try {
    await buildLargeWorkspaceFixture(root);
    const srcFiles = await readdir(join(root, 'src'));
    const generatedFiles = await readdir(join(root, 'generated'));
    assert.ok(srcFiles.some((name) => name.endsWith('.ts')), 'src/ contains .ts sources');
    assert.ok(generatedFiles.some((name) => name.endsWith('.js') || name.endsWith('.d.ts')), 'generated/ contains build outputs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
