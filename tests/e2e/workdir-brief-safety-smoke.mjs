import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from './smoke-server.mjs';

await buildServer();
const { WorkdirBriefService } = await import(
  '../../apps/server/dist/apps/server/src/modules/runtimes/streaming/workdir-brief.service.js'
);

function input(workDir, runId, runtimeType = 'codex') {
  return {
    runId,
    sessionId: `session-${runId}`,
    taskId: `task-${runId}`,
    phase: 'task_execution',
    agent: {
      id: 'agent-1',
      key: 'coder',
      name: 'Coder',
      role: 'coder',
      systemPrompt: '',
      runtimeType,
      capabilityIds: []
    },
    contextPack: {
      systemRules: ['[Skill:safe-edit] Preserve existing project instructions.'],
      sessionGoal: 'Validate production-safe workdir brief handling.',
      taskBrief: { goal: 'Run isolated acceptance.', constraints: [], acceptanceCriteria: [] },
      currentTask: { id: `task-${runId}`, title: 'Workdir brief safety', status: 'ready' },
      taskContext: { validationRules: ['Restore exact bytes.'] },
      summaryMemory: {},
      continuationState: {},
      workingDirectory: {
        id: `wd-${runId}`,
        name: 'isolated-workspace',
        kind: 'server_local',
        path: workDir,
        selectedAt: new Date().toISOString()
      },
      agentProfile: {},
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets: [],
      artifacts: [],
      capabilities: [],
      constraints: [],
      budget: {}
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
    budget: {}
  };
}

function findManifest(root) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findManifest(path);
      if (nested) return nested;
    } else if (entry.name === 'backup-manifest.json') {
      return path;
    }
  }
  return undefined;
}

async function withScenario(name, callback) {
  const root = mkdtempSync(join(tmpdir(), `agent-cluster-${name}-`));
  const workDir = join(root, 'workspace');
  const stagingDir = join(root, 'staging');
  mkdirSync(workDir, { recursive: true });
  const previousStaging = process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR;
  const previousEnabled = process.env.AGENT_CLUSTER_WORKDIR_BRIEF;
  const previousTtl = process.env.AGENT_CLUSTER_BRIEF_TTL_MS;
  process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = stagingDir;
  process.env.AGENT_CLUSTER_WORKDIR_BRIEF = 'true';
  try {
    await callback({ root, workDir, stagingDir });
  } finally {
    if (previousStaging === undefined) delete process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR;
    else process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = previousStaging;
    if (previousEnabled === undefined) delete process.env.AGENT_CLUSTER_WORKDIR_BRIEF;
    else process.env.AGENT_CLUSTER_WORKDIR_BRIEF = previousEnabled;
    if (previousTtl === undefined) delete process.env.AGENT_CLUSTER_BRIEF_TTL_MS;
    else process.env.AGENT_CLUSTER_BRIEF_TTL_MS = previousTtl;
    rmSync(root, { recursive: true, force: true });
  }
}

await withScenario('brief-existing', async ({ workDir, stagingDir }) => {
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 原始说明\r\n保留 CRLF 与二进制尾部\r\n', 'utf8'),
    Buffer.from([0x00, 0xff, 0x0d, 0x0a])
  ]);
  const target = join(workDir, 'AGENTS.md');
  writeFileSync(target, original);

  const service = new WorkdirBriefService();
  const lease = service.prepare(input(workDir, 'existing'), 'codex');
  assert.ok(lease);
  assert.ok(lease.taskSidecarPath.startsWith(stagingDir));
  assert.ok(!lease.taskSidecarPath.startsWith(workDir));
  assert.equal(readFileSync(target, 'utf8').match(/agent-cluster:workdir-brief:start/g)?.length, 1);
  assert.throws(
    () => service.prepare(input(workDir, 'conflict'), 'codex'),
    /WORKDIR_LEASE_CONFLICT/
  );

  const recovered = new WorkdirBriefService().recoverAll();
  assert.equal(recovered.restored, 1);
  assert.equal(recovered.failed, 0);
  assert.deepEqual(readFileSync(target), original);
  lease.restore();
  assert.deepEqual(readFileSync(target), original);

  process.env.AGENT_CLUSTER_BRIEF_TTL_MS = '1';
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cleanup = new WorkdirBriefService().recoverAll();
  assert.equal(cleanup.expiredRemoved, 1);
  assert.ok(!existsSync(lease.briefStagingDir));
});

await withScenario('brief-new-file', async ({ workDir }) => {
  const target = join(workDir, 'CLAUDE.md');
  const lease = new WorkdirBriefService().prepare(input(workDir, 'new-file', 'claude_code'), 'claude_code');
  assert.ok(lease);
  assert.ok(existsSync(target));
  const recovered = new WorkdirBriefService().recoverAll();
  assert.equal(recovered.restored, 1);
  assert.ok(!existsSync(target), 'Recovery must remove an injected file that did not exist before the run.');
});

await withScenario('brief-staging-failure', async ({ root, workDir }) => {
  const original = Buffer.from('do not modify me\r\n', 'utf8');
  const target = join(workDir, 'AGENTS.md');
  const stagingBlocker = join(root, 'staging-blocker');
  writeFileSync(target, original);
  writeFileSync(stagingBlocker, 'not a directory', 'utf8');
  process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = stagingBlocker;

  assert.throws(() => new WorkdirBriefService().prepare(input(workDir, 'staging-failure'), 'codex'));
  assert.deepEqual(readFileSync(target), original, 'A staging failure must leave the workspace untouched.');
});

await withScenario('brief-corrupt-backup', async ({ workDir, stagingDir }) => {
  const target = join(workDir, 'AGENTS.md');
  writeFileSync(target, Buffer.from('original evidence\n', 'utf8'));
  const lease = new WorkdirBriefService().prepare(input(workDir, 'corrupt-backup'), 'codex');
  assert.ok(lease);
  const manifestPath = findManifest(stagingDir);
  assert.ok(manifestPath);
  const manifestBefore = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestBefore.targets[0].backupPath, 'tampered backup', 'utf8');

  const recovery = new WorkdirBriefService().recoverAll();
  assert.equal(recovery.restored, 0);
  assert.equal(recovery.failed, 1);
  const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifestAfter.status, 'active');
  assert.ok(existsSync(manifestAfter.leasePath));
  assert.ok(existsSync(manifestAfter.targets[0].backupPath));
  assert.match(readFileSync(target, 'utf8'), /agent-cluster:workdir-brief:start/);
});

console.log('workdir brief production-safety acceptance ok');
