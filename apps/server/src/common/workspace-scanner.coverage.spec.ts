import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanServerWorkspace } from './workspace-scanner.js';

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ws-cov-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('scanServerWorkspace exposes coverage stats', async () => {
  await withTempDir(async (root) => {
    // 正常文件
    await writeFile(join(root, 'index.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'README.md'), '# title\n');
    // 敏感文件
    await writeFile(join(root, '.env'), 'SECRET=value\n');
    // 超大文件 (>80_000 bytes)
    await writeFile(join(root, 'big.ts'), 'x'.repeat(90_000));
    // 忽略目录
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'dummy.js'), 'noop');

    const { workspaceSnapshot } = await scanServerWorkspace(root);
    const coverage = workspaceSnapshot.coverage;
    assert.ok(coverage, 'workspaceSnapshot.coverage must be present');
    assert.equal(typeof coverage.totalEntriesSeen, 'number');
    assert.equal(typeof coverage.scannedEntries, 'number');
    assert.equal(typeof coverage.readableFiles, 'number');
    assert.ok(coverage.totalEntriesSeen >= coverage.scannedEntries);
    assert.ok(coverage.readableFiles >= 2, `expected >=2 readable, got ${coverage.readableFiles}`);
    assert.equal(coverage.skippedByReason.sensitive ?? 0, 1, '.env should be sensitive');
    assert.equal(coverage.skippedByReason.too_large ?? 0, 1, 'big.ts should be too_large');
    assert.equal(coverage.skippedByReason.ignored_directory ?? 0, 1, 'node_modules should be ignored_directory');
    // sum(skippedByReason) must match skipped.length
    const skippedSum = Object.values(coverage.skippedByReason).reduce(
      (acc, value) => acc + (value ?? 0),
      0
    );
    assert.equal(skippedSum, workspaceSnapshot.skipped.length, 'coverage skippedByReason sum should match skipped[]');
  });
});

test('scanServerWorkspace coverage counts limit_exceeded entries', async () => {
  await withTempDir(async (root) => {
    // Build a deep directory tree to exceed maxScannedEntries=350.
    for (let i = 0; i < 400; i += 1) {
      await writeFile(join(root, `file-${i}.ts`), `// ${i}\n`);
    }
    const { workspaceSnapshot } = await scanServerWorkspace(root);
    const coverage = workspaceSnapshot.coverage;
    assert.ok(coverage);
    assert.ok((coverage.skippedByReason.limit_exceeded ?? 0) > 0, 'expected limit_exceeded > 0');
  });
});
