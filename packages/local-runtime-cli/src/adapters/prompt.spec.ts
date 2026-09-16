import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvocationPlan, LocalRuntimePermissionPolicy } from '@agent-cluster/shared';
import { buildLocalRuntimePrompt } from './prompt.js';

function plan(kind: InvocationPlan['expectedOutput']['kind']): InvocationPlan {
  return {
    invocationId: 'invocation-local-prompt',
    sessionId: 'session-local-prompt',
    phase: 'task_execution',
    agent: { name: 'Local Agent' },
    executionTarget: {
      runtimeType: 'claude_code',
      executionLocation: 'local',
      workspaceProviderKind: 'local_bridge',
      requiredCapabilities: ['read', 'write'],
      writeMode: 'propose_changes'
    },
    contextEnvelope: {},
    toolCatalog: { decisions: [] },
    expectedOutput: { kind, schemaVersion: '1.0' }
  } as unknown as InvocationPlan;
}

const permissions = { readDirectory: 'allow' } as unknown as LocalRuntimePermissionPolicy;

// 2026-08-21 的真实失败发生在本地路径:prompt 只给 Schema 和 example,模型把单个 Artifact 当成了返回值本体。
test('local prompt carries the shared root-object discipline', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('task_execution_result'), permissions);
  assert.match(prompt, /STRUCTURED OUTPUT CONTRACT:/);
  assert.match(prompt, /Never wrap the result in content, output, result, payload, artifact, or metadata/);
  assert.match(prompt, /Include every required schema property and do not add undeclared root properties/);
  assert.match(prompt, /Every array property must be a JSON array, never a string or a JSON-encoded string/);
});

test('local prompt states the schemaVersion and kind literals the failing runs omitted', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('task_execution_result'), permissions);
  assert.match(prompt, /must include schemaVersion: "1\.0" and kind: "task_execution_result"/);
});

test('local Claude prompt names StructuredOutput as the submission tool', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('task_execution_result'), permissions, {
    submissionToolName: 'StructuredOutput'
  });
  assert.match(prompt, /Pass every schema property directly as the root arguments to StructuredOutput/);
});

test('local Codex prompt keeps the discipline without naming a tool it does not have', () => {
  const prompt = buildLocalRuntimePrompt('Codex', plan('task_execution_result'), permissions);
  assert.match(prompt, /Pass every schema property directly as the root object you return/);
  assert.ok(!prompt.includes('StructuredOutput'), 'Codex prompt must not reference a Claude-only tool');
});

test('local prompt requires the three task_execution_result empty-value fields', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('task_execution_result'), permissions, {
    submissionToolName: 'StructuredOutput'
  });
  assert.match(prompt, /requestedContext is required; use null/);
  assert.match(prompt, /agentMessages is required; use \[\]/);
  assert.match(prompt, /nextSuggestedActions is required; use \[\]/);
  assert.match(prompt, /changedArtifacts must be an array of artifact objects/);
  assert.match(prompt, /Do not JSON-encode changedArtifacts or an artifact as a string/);
});

// 2026-08-21 09:46:07 的 task_brief 失败:字段名正确,但六个数组字段被提交成字符串。
test('local prompt forbids stringified task_brief array fields', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('task_brief'), permissions, {
    submissionToolName: 'StructuredOutput'
  });
  assert.match(
    prompt,
    /scope, outOfScope, constraints, acceptanceCriteria, risks, and openQuestions must each be an array of strings/
  );
  assert.match(prompt, /never submit these fields as a single string/);
  assert.match(prompt, /suggestedTasks must be an array of task objects, not a string/);
});

test('local task acceptance prompt instructs QA to accept the review assignment before reporting defects', () => {
  const prompt = buildLocalRuntimePrompt('Codex', plan('task_acceptance_decision'), permissions);
  assert.match(prompt, /intake decision, not a quality review/i);
  assert.match(prompt, /QA, test, review, or validation Agent.*must return status "accepted"/i);
  assert.match(prompt, /fixable quality defects.*decision "revise"/i);
});

test('local prompt still carries the workspace boundary and the output contract', () => {
  const prompt = buildLocalRuntimePrompt('Claude Code', plan('agent_message'), permissions);
  assert.match(prompt, /You are running as an Agent Cluster local Claude Code Runtime\./);
  assert.match(prompt, /Operate only inside the current authorized working directory\./);
  assert.match(prompt, /Required output kind: agent_message\./);
  assert.match(prompt, /Output JSON Schema:/);
  assert.match(prompt, /Output JSON example:/);
  assert.match(prompt, /Runtime input JSON:/);
});
