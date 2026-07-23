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

test('data-flow source outranks nested demo routers', () => {
  for (const path of [
    'src/shared/model.ts',
    'src/chains/articleChain.ts',
    'src/rag/pipeline.ts',
    'src/memory/chatMemory.ts',
    'src/tools/weatherTool.ts'
  ]) {
    assert.ok(
      workspaceFileScanPriority(path) < workspaceFileScanPriority('src/demos/08-rag/index.ts'),
      `${path} should be read before nested demo indexes`
    );
  }
});

test('bounded scanning keeps architecture data-flow bodies when demo indexes exceed the read limit', async () => {
  await withTempDir(async (root) => {
    const coreFiles = [
      'src/shared/model.ts',
      'src/chains/articleChain.ts',
      'src/rag/pipeline.ts',
      'src/memory/chatMemory.ts',
      'src/tools/weatherTool.ts'
    ];
    for (const path of coreFiles) {
      const directory = path.slice(0, path.lastIndexOf('/'));
      await mkdir(join(root, ...directory.split('/')), { recursive: true });
      await writeFile(join(root, ...path.split('/')), `export const value = '${path}';`);
    }
    for (let index = 0; index < 90; index += 1) {
      const directory = join(root, 'src', 'demos', String(index).padStart(2, '0'));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.ts'), `export const demo = ${index};`);
    }

    const { workspaceSnapshot } = await scanServerWorkspace(root);
    const readable = new Set(workspaceSnapshot.files.map((file) => file.path));
    for (const path of coreFiles) assert.ok(readable.has(path), `expected readable core evidence ${path}`);
  });
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
