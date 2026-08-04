import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './smoke-server.mjs';

await buildServer();

const { applyServerLocalChangeSet } = await import(
  '../../apps/server/dist/apps/server/src/modules/workspaces/workspace-apply-change-set.js'
);

const baseRevision = { id: 'conflict-guard-base', observedAt: new Date().toISOString() };
const hash = (content) => ({
  algorithm: 'sha256',
  value: createHash('sha256').update(content).digest('hex')
});

let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-source-conflict-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });

  const base = 'one\ntwo\nthree\n';
  await writeFile(join(workspaceRoot, 'src', 'mergeable.txt'), 'ONE\ntwo\nthree\n');
  const merged = await applyServerLocalChangeSet({
    rootPath: workspaceRoot,
    currentRevision: { id: 'conflict-guard-current', observedAt: new Date().toISOString() },
    changeSet: {
      id: 'conflict-guard-mergeable',
      baseRevision,
      createdAt: new Date().toISOString(),
      changes: [{
        operation: 'update',
        path: 'src/mergeable.txt',
        expectedHash: hash(base),
        baseContent: base,
        content: 'one\ntwo\nTHREE\n',
        encoding: 'utf-8'
      }]
    }
  });
  if (!merged.ok) throw new Error(`Expected non-overlapping edits to merge: ${JSON.stringify(merged.conflicts)}`);
  if (await readFile(join(workspaceRoot, 'src', 'mergeable.txt'), 'utf8') !== 'ONE\ntwo\nTHREE\n') {
    throw new Error('Expected the three-way merge to preserve both non-overlapping edits.');
  }

  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'changed elsewhere\n');
  const rejected = await applyServerLocalChangeSet({
    rootPath: workspaceRoot,
    currentRevision: { id: 'conflict-guard-current-2', observedAt: new Date().toISOString() },
    changeSet: {
      id: 'conflict-guard-overlap',
      baseRevision,
      createdAt: new Date().toISOString(),
      changes: [{
        path: 'src/feature.txt',
        operation: 'update',
        expectedHash: hash('original source\n'),
        baseContent: 'original source\n',
        content: 'agent update\n',
        encoding: 'utf-8'
      }]
    }
  });
  if (rejected.ok || rejected.conflicts[0]?.code !== 'WORKSPACE_MERGE_CONFLICT') {
    throw new Error(`Expected an overlapping update to return a merge conflict. Got: ${JSON.stringify(rejected)}`);
  }
  if (await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8') !== 'changed elsewhere\n') {
    throw new Error('Conflict handling must preserve current workspace content.');
  }

  const createdResult = await applyServerLocalChangeSet({
    rootPath: workspaceRoot,
    currentRevision: baseRevision,
    changeSet: {
      id: 'conflict-guard-create',
      baseRevision,
      createdAt: new Date().toISOString(),
      changes: [{
        path: 'src/created.txt',
        operation: 'create',
        content: 'created by agent\n',
        encoding: 'utf-8'
      }]
    }
  });
  if (!createdResult.ok) throw new Error(`Expected conflict-free create to apply: ${JSON.stringify(createdResult)}`);
  if (await readFile(join(workspaceRoot, 'src', 'created.txt'), 'utf8') !== 'created by agent\n') {
    throw new Error('Expected conflict-free create to be applied.');
  }

  console.log('server local three-way merge conflict guard smoke ok');
} finally {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

process.exit(0);
