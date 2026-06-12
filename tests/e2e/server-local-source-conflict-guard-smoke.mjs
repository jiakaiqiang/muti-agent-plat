import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './smoke-server.mjs';

await buildServer();

const { applyServerLocalFileChanges } = await import(
  '../../apps/server/dist/apps/server/src/common/server-file-changes.js'
);

let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-source-conflict-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'changed elsewhere\n');

  let rejected = false;
  try {
    await applyServerLocalFileChanges(workspaceRoot, [
      {
        path: 'src/feature.txt',
        operation: 'update',
        previousContent: 'original source\n',
        content: 'agent update\n',
        encoding: 'utf-8',
        source: 'actual_filesystem_snapshot'
      }
    ]);
  } catch (error) {
    rejected = /拒绝覆盖/.test(error instanceof Error ? error.message : String(error));
  }

  if (!rejected) {
    throw new Error('Expected stale source update to be rejected.');
  }

  const content = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  if (content !== 'changed elsewhere\n') {
    throw new Error(`Conflict guard must preserve current file content. Got: ${content}`);
  }

  await applyServerLocalFileChanges(workspaceRoot, [
    {
      path: 'src/created.txt',
      operation: 'create',
      previousContent: null,
      content: 'created by agent\n',
      encoding: 'utf-8',
      source: 'actual_filesystem_snapshot'
    }
  ]);

  const created = await readFile(join(workspaceRoot, 'src', 'created.txt'), 'utf8');
  if (created !== 'created by agent\n') {
    throw new Error('Expected conflict-free create to be applied.');
  }

  console.log('server local source conflict guard smoke ok');
} finally {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
