import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput } from '@agent-cluster/shared';
import { WorkdirBriefService } from './workdir-brief.service.js';

function input(workDir: string, runId = 'run-1'): AgentRunInput {
  return {
    runId,
    sessionId: 'session-1',
    taskId: 'task-1',
    phase: 'task_execution',
    agent: {
      id: 'agent-1', key: 'coder', name: 'Coder', role: 'coder', systemPrompt: '', runtimeType: 'codex', capabilityIds: []
    },
    contextPack: {
      systemRules: [], sessionGoal: 'Implement feature', taskContext: {} as never, summaryMemory: {} as never,
      continuationState: {} as never,
      workingDirectory: { id: 'wd-1', name: 'workspace', kind: 'server_local', path: workDir, selectedAt: new Date().toISOString() },
      agentProfile: {} as never, relevantEvents: [], relevantMemories: [], ragSnippets: [], artifacts: [], capabilities: [], constraints: [], budget: {}
    },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
    budget: {}
  };
}

function withTemp(testFn: (workDir: string, stagingDir: string, service: WorkdirBriefService) => void) {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-brief-'));
  const workDir = join(root, 'workspace');
  const stagingDir = join(root, 'staging');
  process.env.AGENT_CLUSTER_BRIEF_STAGING_DIR = stagingDir;
  mkdirSync(workDir, { recursive: true });
  try {
    testFn(workDir, stagingDir, new WorkdirBriefService());
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
    const recovery = new WorkdirBriefService().recoverAll();
    assert.equal(recovery.restored, 1);
    assert.deepEqual(readFileSync(join(workDir, 'CLAUDE.md')), original);
    lease?.restore();
  });
});
