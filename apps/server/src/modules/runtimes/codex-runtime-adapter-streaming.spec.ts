import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput } from '@agent-cluster/shared';
import { buildCodexStreamingOptions } from './codex-runtime-adapter.service.js';

/**
 * M4-04 · CodexAdapter 消费 options.resume 参数。
 *
 * buildCodexStreamingOptions 是从 runStreaming 里抽取出的纯函数,
 * 只做一件事:根据 input.options.resume 和 baseEnv/command/args 组装
 * StreamingRunnerOptions,便于在不真正 spawn 子进程的情况下断言。
 */

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    sessionId: 'ses-1',
    phase: 'task_execution',
    agent: {
      id: 'agent-1',
      key: 'coder',
      name: 'Coder',
      role: 'coder',
      systemPrompt: '',
      runtimeType: 'codex',
      capabilityIds: []
    },
    contextPack: {
      systemRules: [],
      sessionGoal: 'test',
      taskContext: {} as never,
      summaryMemory: {
        goal: '',
        currentState: '',
        confirmedFacts: [],
        completed: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        nextSteps: []
      },
      continuationState: {
        phase: 'task_execution',
        sessionStatus: 'DRAFT_INPUT',
        pendingTaskIds: [],
        runningTaskIds: [],
        completedTaskIds: [],
        blockedTaskIds: [],
        nextAgentKeys: [],
        handoffRefs: [],
        sourceEventIds: [],
        sourceArtifactIds: [],
        resumeHints: []
      },
      agentProfile: {} as never,
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets: [],
      artifacts: [],
      capabilities: [],
      constraints: [],
      budget: {}
    },
    expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
    budget: {},
    ...overrides
  };
}

const baseParams = {
  command: 'codex',
  args: ['app-server', '--listen', 'stdio://'],
  baseEnv: { PATH: '/usr/bin' } as Record<string, string | undefined>,
  firstFrameTimeoutMs: 30_000,
  idleTimeoutMs: 600_000,
  absoluteTimeoutMs: 900_000
};

test('M4-04: 无 resume → cwd undefined, env 无 AGENT_CLUSTER_CODEX_RESUME_ID', () => {
  const input = makeInput({ options: undefined });
  const opts = buildCodexStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, undefined);
  assert.equal(opts.env?.AGENT_CLUSTER_CODEX_RESUME_ID, undefined);
  assert.equal(opts.command, 'codex');
  assert.deepEqual(opts.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(opts.env?.PATH, '/usr/bin');
  assert.equal(opts.absoluteTimeoutMs, 900_000);
});

test('M4-04: 有 resume.cliSessionId → env.AGENT_CLUSTER_CODEX_RESUME_ID 带 id', () => {
  const input = makeInput({ options: { resume: { cliSessionId: 'c1' } } });
  const opts = buildCodexStreamingOptions({ input, ...baseParams });
  assert.equal(opts.env?.AGENT_CLUSTER_CODEX_RESUME_ID, 'c1');
  // baseEnv 其他字段应保留
  assert.equal(opts.env?.PATH, '/usr/bin');
  // 无 workDir 时 cwd 保持 undefined
  assert.equal(opts.cwd, undefined);
});

test('M4-04: 有 resume.workDir → opts.cwd 为该目录', () => {
  const input = makeInput({ options: { resume: { workDir: '/tmp/x' } } });
  const opts = buildCodexStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, '/tmp/x');
  // 无 cliSessionId 时不注入 env 变量
  assert.equal(opts.env?.AGENT_CLUSTER_CODEX_RESUME_ID, undefined);
});

test('M4-04: resume.cliSessionId + workDir 同时存在 → 两者都生效', () => {
  const input = makeInput({
    options: { resume: { cliSessionId: 'c2', workDir: '/tmp/y' } }
  });
  const opts = buildCodexStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, '/tmp/y');
  assert.equal(opts.env?.AGENT_CLUSTER_CODEX_RESUME_ID, 'c2');
});

test('M4-04: resume 字段类型不匹配（非 string）→ 忽略, 保持默认', () => {
  const input = makeInput({
    options: { resume: { cliSessionId: 123 as unknown as string, workDir: null as unknown as string } }
  });
  const opts = buildCodexStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, undefined);
  assert.equal(opts.env?.AGENT_CLUSTER_CODEX_RESUME_ID, undefined);
});
