import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanServerWorkspace, workspaceFileScanPriority } from './workspace-scanner.js';

async function withTempDir<T>(run: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-priority-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('workspaceFileScanPriority ranks rules, entrypoints, config, and source before ordinary docs', () => {
  const ordinaryDocumentPriority = workspaceFileScanPriority('docs/guide.md');

  assert.ok(workspaceFileScanPriority('AGENTS.md') < ordinaryDocumentPriority);
  assert.ok(workspaceFileScanPriority('apps/server/src/main.ts') < ordinaryDocumentPriority);
  assert.ok(workspaceFileScanPriority('package.json') < ordinaryDocumentPriority);
  assert.ok(workspaceFileScanPriority('src/modules/session.service.ts') < ordinaryDocumentPriority);
});

test('workspaceFileScanPriority uses deterministic category ordering', () => {
  assert.ok(workspaceFileScanPriority('nested/AGENTS.md') < workspaceFileScanPriority('src/main.ts'));
  assert.ok(workspaceFileScanPriority('src/main.ts') < workspaceFileScanPriority('tsconfig.json'));
  assert.ok(workspaceFileScanPriority('tsconfig.json') < workspaceFileScanPriority('src/app.ts'));
  assert.ok(workspaceFileScanPriority('src/app.ts') < workspaceFileScanPriority('docs/guide.md'));
});

test('scanServerWorkspace uses the same priority ordering as browser scanning', async () => {
  await withTempDir(async (root) => {
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(root, `guide-${String(index).padStart(2, '0')}.md`), `# Guide ${index}`);
    }
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'export const boot = true;');

    const { workspaceSnapshot } = await scanServerWorkspace(root);

    assert.equal(workspaceSnapshot.files.some((file) => file.path === 'src/main.ts'), true);
    assert.equal(workspaceSnapshot.files.length, 80);
    const paths = workspaceSnapshot.files.map((file) => file.path);
    assert.deepEqual(paths, [...paths].sort((left, right) => (
      workspaceFileScanPriority(left) - workspaceFileScanPriority(right) || left.localeCompare(right)
    )));
  });
});
