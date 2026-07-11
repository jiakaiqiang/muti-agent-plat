import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { searchServerLocalText } from './workspace-search-text.js';

const revision = {
  id: 'revision-57',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t57-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('searchServerLocalText finds matches with line numbers and previews', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'const foo = 1;\nconst target = 2;\nconst bar = 3;\n');
    await writeFile(join(root, 'b.ts'), 'const nothing = 0;\n');
    const result = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'target' }
    });
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, 'a.ts');
    assert.equal(result.matches[0].line, 2);
    assert.match(result.matches[0].preview, /target/);
  });
});

test('searchServerLocalText caps results and reports truncated=true', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'match\nmatch\nmatch\nmatch\nmatch\n');
    const result = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'match', maxResults: 2 }
    });
    assert.equal(result.matches.length, 2);
    assert.equal(result.truncated, true);
  });
});

test('searchServerLocalText skips generated directories', async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'a.ts'), 'needle');
    await writeFile(join(root, 'app.ts'), 'needle here');
    const result = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'needle' }
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, 'app.ts');
  });
});

test('searchServerLocalText caps preview length', async () => {
  await withTempRoot(async (root) => {
    const long = 'x'.repeat(500) + 'needle' + 'y'.repeat(500);
    await writeFile(join(root, 'a.ts'), long);
    const result = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'needle' }
    });
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches[0].preview.length <= 240, `preview length ${result.matches[0].preview.length} exceeds cap`);
    assert.match(result.matches[0].preview, /needle/);
  });
});

test('searchServerLocalText respects caseSensitive flag', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'HelloWorld\nhelloworld\n');
    const insensitive = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'helloworld' }
    });
    assert.equal(insensitive.matches.length, 2);
    const sensitive = await searchServerLocalText({
      rootPath: root,
      revision,
      input: { query: 'helloworld', caseSensitive: true }
    });
    assert.equal(sensitive.matches.length, 1);
    assert.equal(sensitive.matches[0].line, 2);
  });
});
