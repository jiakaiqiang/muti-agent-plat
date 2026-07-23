import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';

test('ServerLocalWorkspaceProvider implements the workspace plane against a real directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-provider-'));
  try {
    await writeFile(join(root, 'main.ts'), 'export const value = 1;');
    const provider = new ServerLocalWorkspaceProvider(root);
    assert.equal(provider.capabilities().read, true);
    const listed = await provider.listDirectory({});
    assert.equal(listed.entries.some((entry) => entry.path === 'main.ts'), true);
    const read = await provider.readFile({ path: 'main.ts' });
    assert.match(read.content, /value = 1/);
    const searched = await provider.searchText({ query: 'value' });
    assert.equal(searched.matches[0]?.path, 'main.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
