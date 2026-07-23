import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkdirBriefService } from './workdir-brief.service.js';
import { makeInvocationPlan } from '../invocation-plan.fixture.js';

function input(_workDir: string, invocationId = 'run-1') {
  return makeInvocationPlan({
    invocationId: invocationId,
    sessionId: 'session-1',
    taskId: 'task-1',
    phase: 'task_execution',
    agent: {
      agentId: 'agent-1', key: 'coder', name: 'Coder', role: 'coder', systemPrompt: ''
    },
    executionTarget: { runtimeType: 'codex' },
    contextEnvelope: {
      L1: { sessionGoal: 'Implement feature' },
      L5: { bullets: ['Memory: SUPPLEMENTAL_WORKDIR_MARKER'], turnCount: 2 }
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
  });
}

function withTemp(testFn: (workDir: string, stagingDir: string, service: WorkdirBriefService) => void) {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-brief-'));
  const workDir = join(root, 'workspace');
  const stagingDir = join(root, 'staging');
  process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = stagingDir;
  mkdirSync(workDir, { recursive: true });
  try {
    testFn(
      workDir,
      stagingDir,
      new WorkdirBriefService({ resolveServerRoot: () => workDir } as never)
    );
  } finally {
    delete process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR;
    rmSync(root, { recursive: true, force: true });
  }
}

test('injects and removes a new AGENTS.md exactly', () => {
  withTemp((workDir, _stagingDir, service) => {
    const lease = service.prepare(input(workDir), 'codex');
    assert.ok(lease);
    assert.match(readFileSync(join(workDir, 'AGENTS.md'), 'utf8'), /Task sidecar:/);
    const sidecar = JSON.parse(readFileSync(lease.taskSidecarPath, 'utf8')) as Record<string, any>;
    assert.equal(sidecar.contextEnvelope.version, 'v2');
    assert.deepEqual(sidecar.contextEnvelope.L5.bullets, ['Memory: SUPPLEMENTAL_WORKDIR_MARKER']);
    assert.equal('goal' in sidecar, false);
    assert.equal('currentTask' in sidecar, false);
    assert.equal('systemRules' in sidecar, false);
    assert.equal('toolCatalogHash' in sidecar, false);
    lease.restore();
    assert.throws(() => readFileSync(join(workDir, 'AGENTS.md')));
  });
});

test('restores existing instruction bytes without stacking', () => {
  withTemp((workDir, _stagingDir, service) => {
    const original = Buffer.from('# Existing\r\nkeep bytes\r\n', 'utf8');
    writeFileSync(join(workDir, 'AGENTS.md'), original);
    const first = service.prepare(input(workDir, 'run-1'), 'codex');
    first?.restore();
    assert.deepEqual(readFileSync(join(workDir, 'AGENTS.md')), original);
    const second = service.prepare(input(workDir, 'run-2'), 'codex');
    const injected = readFileSync(join(workDir, 'AGENTS.md'), 'utf8');
    assert.equal(injected.match(/agent-cluster:workdir-brief:start/g)?.length, 1);
    second?.restore();
    assert.deepEqual(readFileSync(join(workDir, 'AGENTS.md')), original);
  });
});

test('rejects concurrent workdir leases and recovers an active manifest after restart', () => {
  withTemp((workDir, _stagingDir, service) => {
    const original = Buffer.from('original', 'utf8');
    writeFileSync(join(workDir, 'CLAUDE.md'), original);
    const lease = service.prepare(input(workDir), 'claude_code');
    assert.throws(() => service.prepare(input(workDir, 'run-2'), 'claude_code'), /WORKDIR_LEASE_CONFLICT/);
    const recovery = new WorkdirBriefService({ resolveServerRoot: () => workDir } as never).recoverAll();
    assert.equal(recovery.restored, 1);
    assert.deepEqual(readFileSync(join(workDir, 'CLAUDE.md')), original);
    lease?.restore();
  });
});

test('deleting a Session restores active instructions and removes its brief directory', () => {
  withTemp((workDir, stagingDir, service) => {
    const original = Buffer.from('# Existing\n', 'utf8');
    writeFileSync(join(workDir, 'AGENTS.md'), original);
    service.prepare(input(workDir), 'codex');

    service.deleteSessionDirectory('session-1');

    assert.deepEqual(readFileSync(join(workDir, 'AGENTS.md')), original);
    assert.throws(() => readFileSync(join(stagingDir, 'runs', 'session-1', 'run-1', 'backup-manifest.json')));
  });
});
