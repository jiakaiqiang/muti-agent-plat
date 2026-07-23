import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRunResult,
  FileMetadata,
  InvocationPlan,
  ListDirectoryInput,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { createRuntimeArtifactOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { BrowserWorkspaceMirrorService } from './browser-workspace-mirror.service.js';

const revision: WorkspaceRevision = {
  id: 'browser-revision-1',
  observedAt: '2026-07-14T00:00:00.000Z'
};

function hash(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function browserProvider(files: Record<string, string>) {
  const metadata = (path: string): FileMetadata => ({
    path,
    kind: 'file',
    size: Buffer.byteLength(files[path]!, 'utf8'),
    hash: { algorithm: 'sha256', value: hash(files[path]!) },
    revision
  });
  return {
    getRevision: async () => revision,
    async listDirectory(input: ListDirectoryInput) {
      const path = input.path ?? '';
      const prefix = path ? `${path}/` : '';
      const children = new Map<string, FileMetadata>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        const [name, ...rest] = remainder.split('/');
        if (!name) continue;
        const childPath = prefix ? `${path}/${name}` : name;
        children.set(
          childPath,
          rest.length
            ? { path: childPath, kind: 'directory', revision }
            : metadata(filePath)
        );
      }
      return {
        path,
        entries: [...children.values()].sort((left, right) => left.path.localeCompare(right.path)),
        revision
      };
    },
    async readFile(input: { path: string }) {
      const content = files[input.path];
      if (content === undefined) throw new Error(`missing browser file: ${input.path}`);
      return {
        path: input.path,
        content,
        encoding: 'utf-8' as const,
        byteLength: Buffer.byteLength(content, 'utf8'),
        truncated: false,
        revision,
        hash: { algorithm: 'sha256' as const, value: hash(content) }
      };
    }
  };
}

function plan(): InvocationPlan {
  return makeInvocationPlan({
    invocationId: 'browser-invocation',
    sessionId: 'browser-session',
    taskId: 'browser-task',
    phase: 'task_execution',
    executionTarget: {
      runtimeType: 'codex',
      workspaceProviderKind: 'browser_broker',
      writeMode: 'propose_changes',
      requiredCapabilities: ['read', 'write', 'command', 'test']
    },
    contextEnvelope: {
      workspaceId: 'browser-workspace',
      L0: {
        workspace: {
          workspaceId: 'browser-workspace',
          providerKind: 'browser_broker',
          revision
        }
      }
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' }
  });
}

function completed(input: InvocationPlan): AgentRunResult {
  const proposal = createRuntimeArtifactOutput({
    type: 'code_diff',
    title: 'adapter-reported change',
    content: 'advisory only',
    metadata: {
      validationEvidence: null,
      summaryMemoryCheckpoint: null,
      fileChanges: [{
        path: 'src/index.ts',
        operation: 'update',
        content: 'untrusted adapter content',
        previousContent: 'export const version = 1;\n',
        encoding: 'utf-8',
        source: 'runtime_proposed_change'
      }]
    }
  });
  return {
    invocationId: input.invocationId,
    runtimeType: input.executionTarget.runtimeType,
    status: 'completed',
    output: {
      schemaVersion: '1.0',
      kind: 'task_execution_result',
      status: 'completed',
      summary: 'updated browser mirror',
      completedItems: [],
      changedArtifacts: [proposal],
      requestedContext: null,
      agentMessages: [],
      nextSuggestedActions: [],
      risks: []
    },
    events: [],
    artifacts: [proposal],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'codex' }
  };
}

test('materializes a browser workspace and captures reviewed changes without writing the browser source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-browser-mirror-'));
  const previousRoot = process.env.AGENT_CLUSTER_BROWSER_MIRROR_ROOT;
  process.env.AGENT_CLUSTER_BROWSER_MIRROR_ROOT = root;
  const source = {
    '.gitignore': 'src/index.ts\n',
    'README.md': '# Browser workspace\n',
    'src/index.ts': 'export const value = 1;\n'
  };
  try {
    const bindings = new InvocationWorkspaceBindingsService();
    const provider = browserProvider(source);
    const service = new BrowserWorkspaceMirrorService(
      bindings,
      { resolveBrowser: () => provider } as never
    );
    const input = plan();
    const lease = await service.prepare(input);

    assert.equal(await readFile(join(lease.manifest.mirrorRoot, 'src', 'index.ts'), 'utf8'), source['src/index.ts']);
    assert.equal(bindings.resolveServerRoot(input), lease.manifest.mirrorRoot);
    await writeFile(join(lease.manifest.mirrorRoot, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(lease.manifest.mirrorRoot, 'created.txt'), 'created by Codex\n', 'utf8');

    const result = await service.capture(lease, completed(input));
    lease.release();

    assert.equal(source['src/index.ts'], 'export const value = 1;\n');
    assert.equal(result.workspaceExecution?.mode, 'browser_mirror');
    assert.equal(result.systemEvidence.workspaceChangeSet?.id, result.workspaceExecution?.changeSet.id);
    assert.equal(result.artifacts.some((artifact) => artifact.title.includes('ChangeSet')), false);
    assert.deepEqual(
      result.workspaceExecution?.changeSet.changes.map((change) => [change.operation, 'path' in change ? change.path : change.toPath]),
      [['create', 'created.txt'], ['update', 'src/index.ts']]
    );
    const update = result.workspaceExecution?.changeSet.changes.find(
      (change) => change.operation === 'update' && change.path === 'src/index.ts'
    );
    assert.equal(update?.operation, 'update');
    if (!update || update.operation !== 'update') throw new Error('Expected src/index.ts update ChangeSet entry.');
    assert.equal(update.content, 'export const value = 2;\n');
    assert.equal(result.artifacts[0]?.metadata.fileChanges[0]?.source, 'runtime_proposed_change');
    const proposedChanges = result.output.kind === 'task_execution_result'
      ? result.output.changedArtifacts[0]?.metadata.fileChanges
      : undefined;
    assert.equal(proposedChanges?.length, 1);
    assert.equal(proposedChanges?.[0]?.content, 'untrusted adapter content');
    assert.equal(result.runtimeSession?.workDir, lease.manifest.mirrorRoot);
    assert.equal(bindings.resolveServerRoot(input), undefined);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_CLUSTER_BROWSER_MIRROR_ROOT;
    else process.env.AGENT_CLUSTER_BROWSER_MIRROR_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('manages both Codex and Claude Code for browser-local workspaces only', () => {
  const service = new BrowserWorkspaceMirrorService({} as never, {} as never);
  const codex = plan();
  const claude = makeInvocationPlan({
    executionTarget: { runtimeType: 'claude_code', workspaceProviderKind: 'browser_broker' }
  });
  const serverLocal = makeInvocationPlan({
    executionTarget: { runtimeType: 'codex', workspaceProviderKind: 'server_local' }
  });
  assert.equal(service.shouldManage(codex), true);
  assert.equal(service.shouldManage(claude), true);
  assert.equal(service.shouldManage(serverLocal), false);
});
