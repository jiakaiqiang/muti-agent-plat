import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunInput } from '@agent-cluster/shared';
import { buildClaudeStreamingOptions } from './claude-code-runtime-adapter.service.js';

/**
 * M4-05 · ClaudeAdapter 消费 options.resume 参数。
 *
 * buildClaudeStreamingOptions 是从 runStreaming 里抽取出的纯函数,
 * 只做一件事:根据 input.options.resume 和 baseEnv/command/args 组装
 * ClaudeStreamingRunnerOptions,便于在不真正 spawn 子进程的情况下断言。
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
      runtimeType: 'claude_code',
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

const baseArgs = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--strict-mcp-config',
  '--permission-mode',
  'bypassPermissions'
];

const baseParams = {
  command: 'claude',
  args: baseArgs,
  baseEnv: { PATH: '/usr/bin' } as Record<string, string | undefined>,
  firstFrameTimeoutMs: 30_000,
  idleTimeoutMs: 600_000,
  absoluteTimeoutMs: 900_000
};

test('M4-05: 无 resume → args 不含 --resume, cwd undefined', () => {
  const input = makeInput({ options: undefined });
  const opts = buildClaudeStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, undefined);
  assert.ok(!opts.args.includes('--resume'), 'args should not contain --resume');
  assert.deepEqual(opts.args, baseArgs);
  assert.equal(opts.command, 'claude');
  assert.equal(opts.env?.PATH, '/usr/bin');
  assert.equal(opts.absoluteTimeoutMs, 900_000);
});

test('M4-05: resume.cliSessionId="c1" → args 含 --resume c1, 顺序在原有 flag 之后', () => {
  const input = makeInput({ options: { resume: { cliSessionId: 'c1' } } });
  const opts = buildClaudeStreamingOptions({ input, ...baseParams });
  const resumeIdx = opts.args.indexOf('--resume');
  assert.ok(resumeIdx >= 0, 'args should contain --resume');
  assert.equal(opts.args[resumeIdx + 1], 'c1');
  // baseArgs 内容都保留且顺序不变
  for (let i = 0; i < baseArgs.length; i += 1) {
    assert.equal(opts.args[i], baseArgs[i]);
  }
  // --resume 在原有 flag 之后 (即位于 baseArgs 之后)
  assert.ok(resumeIdx >= baseArgs.length, '--resume should come after the base flags');
  // 无 workDir 时 cwd 保持 undefined
  assert.equal(opts.cwd, undefined);
});

test('M4-05: resume.workDir="/tmp/x" → options.cwd === "/tmp/x"', () => {
  const input = makeInput({ options: { resume: { workDir: '/tmp/x' } } });
  const opts = buildClaudeStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, '/tmp/x');
  // 无 cliSessionId 时 args 不含 --resume
  assert.ok(!opts.args.includes('--resume'), 'args should not contain --resume');
});

test('M4-05: resume.cliSessionId + workDir 同时存在 → 两者都生效', () => {
  const input = makeInput({
    options: { resume: { cliSessionId: 'c2', workDir: '/tmp/y' } }
  });
  const opts = buildClaudeStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, '/tmp/y');
  const resumeIdx = opts.args.indexOf('--resume');
  assert.ok(resumeIdx >= 0);
  assert.equal(opts.args[resumeIdx + 1], 'c2');
});

test('M4-05: resume 字段类型不匹配 (非 string) → 忽略, 保持默认', () => {
  const input = makeInput({
    options: { resume: { cliSessionId: 123 as unknown as string, workDir: null as unknown as string } }
  });
  const opts = buildClaudeStreamingOptions({ input, ...baseParams });
  assert.equal(opts.cwd, undefined);
  assert.ok(!opts.args.includes('--resume'), 'args should not contain --resume');
});
