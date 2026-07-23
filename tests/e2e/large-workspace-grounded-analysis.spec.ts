import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import type {
  ContextEnvelopeV2Budget,
  ContextL0Authority,
  ContextL3EvidenceFile,
  UUID,
  WorkspaceFileSnapshot,
  WorkspaceRevision,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared';
import { buildContextEnvelopeV2 } from '../../apps/server/src/modules/context-v2/context-assembly-builder-v2.js';
import { buildNavigationManifest } from '../../apps/server/src/modules/context-v2/build-navigation-manifest.js';
import { buildProjectMap } from '../../apps/server/src/modules/context-v2/build-project-map.js';
import { evaluateGroundedEvidenceGate } from '../../apps/server/src/modules/context-v2/grounded-evidence-gate.js';
import { scoreEvidenceCandidates } from '../../apps/server/src/modules/context-v2/score-evidence-candidates.js';
import { selectEvidenceWithinBudget } from '../../apps/server/src/modules/context-v2/select-evidence-within-budget.js';
import { buildLargeWorkspaceFixture, LARGE_FIXTURE_FILE_COUNT } from '../../apps/server/src/modules/workspaces/fixtures/build-large-workspace-fixture.js';
import { buildIndexFromSnapshot } from '../../apps/server/src/modules/workspaces/workspace-index/build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from '../../apps/server/src/modules/workspaces/workspace-index/derive-workspace-entrypoints.js';

const revision = {
  id: 'revision-large-workspace-grounded-analysis',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

const BUDGET_BYTES = 24 * 1024;
const SESSION_ID: UUID = '00000000-0000-0000-0000-000000000129';

const BUDGET: ContextEnvelopeV2Budget = {
  inputTokens: 8000,
  navigationTokens: 2000,
  projectMapTokens: 2000,
  evidenceTokens: 4000
};

test('large workspace grounded analysis carries real evidence and passes the grounded gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-large-grounded-'));
  try {
    const fixture = await buildLargeWorkspaceFixture(root);
    assert.ok(fixture.totalFiles >= LARGE_FIXTURE_FILE_COUNT);

    const snapshot = await scanWorkspace(root);
    const index = buildIndexFromSnapshot(snapshot, revision);
    const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
    assert.ok(entrypoints.includes('src/main.ts'));

    const candidates = scoreEvidenceCandidates({
      entries: index,
      entrypoints,
      userMentionedPaths: ['src/main.ts'],
      userKeywords: ['main', 'unit']
    });
    assert.ok(candidates.length > 0, 'candidates must be non-empty for grounded analysis');
    assert.equal(candidates.some((candidate) => candidate.path.startsWith('generated/')), false);

    const contents = new Map<string, ContextL3EvidenceFile>();
    for (const file of snapshot.files) {
      if (!file.content) continue;
      contents.set(file.path, {
        path: file.path,
        content: file.content,
        byteLength: Buffer.byteLength(file.content, 'utf8')
      });
    }

    const selected = selectEvidenceWithinBudget({ candidates, contents, budgetBytes: BUDGET_BYTES });
    assert.ok(selected.files.length > 0, 'grounded evidence must be non-empty');
    assert.ok(selected.totalByteLength <= BUDGET_BYTES);
    assert.ok(selected.files.some((file) => file.path === 'src/main.ts'), 'src/main.ts must appear in grounded evidence');
    assert.equal(selected.files.some((file) => file.path.startsWith('generated/')), false);

    const navigation = buildNavigationManifest({ entries: index, entrypoints, maxEntries: 12 });
    const projectMap = buildProjectMap({ entries: index, entrypoints, detectedStack: snapshot.detectedStack });

    const authority: ContextL0Authority = {
      systemRules: ['Use current workspace evidence.'],
      agentId: 'system-architect',
      profileHash: 'system-architect-profile',
      profileRevision: 1,
      toolCatalogHash: 'read-only-catalog',
      workspace: {
        workspaceId: 'workspace-129',
        rootName: snapshot.rootName,
        providerKind: 'server_local',
        revision
      }
    };

    const envelope = buildContextEnvelopeV2({
      phase: 'execution',
      sessionId: SESSION_ID,
      l0: authority,
      l1: {
        sessionGoal: 'Analyze the large workspace architecture and data flow.',
        phase: 'task_execution',
        navigation
      },
      l2: projectMap,
      l3: selected,
      budget: BUDGET
    });

    assert.equal(envelope.L3.files.length, selected.files.length);
    assert.ok(envelope.L3.totalByteLength > 0, 'envelope evidence must have real byte length');

    const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
    assert.equal(decision.ok, true, `grounded gate must accept large workspace evidence: ${JSON.stringify(decision)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function scanWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  const files: WorkspaceFileSnapshot[] = [];
  const tree = await scanChildren(rootPath, rootPath, files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    rootName: 'large-workspace-grounded-analysis',
    scannedAt: '2026-07-12T00:00:00.000Z',
    fileCount: files.length,
    totalBytes,
    tree,
    files,
    skipped: [],
    detectedStack: ['typescript'],
    entrypoints: ['src/main.ts']
  };
}

async function scanChildren(
  rootPath: string,
  directory: string,
  files: WorkspaceFileSnapshot[]
): Promise<WorkspaceTreeNode[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes: WorkspaceTreeNode[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toWorkspacePath(relative(rootPath, absolutePath));
    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        kind: 'directory',
        children: await scanChildren(rootPath, absolutePath, files)
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(absolutePath);
    const content = await readFile(absolutePath, 'utf8');
    files.push({
      path: relativePath,
      size: fileStat.size,
      language: languageForPath(relativePath),
      content
    });
    nodes.push({ path: relativePath, kind: 'file' });
  }
  return nodes;
}

function toWorkspacePath(path: string): string {
  return path.split(sep).join('/');
}

function languageForPath(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}
