import test from 'node:test';
import assert from 'node:assert/strict';
import { framesToOutput, MapperError } from './frame-to-output.mapper.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

const text = (t: string): RuntimeStreamFrame => ({ kind: 'assistant_text', text: t });
const toolUse = (
  id: string,
  name: string,
  input: unknown
): RuntimeStreamFrame => ({
  kind: 'tool_use',
  toolCallId: id,
  tool: name,
  input
});
const toolResult = (
  id: string,
  name: string,
  output: string,
  isError = false
): RuntimeStreamFrame => ({
  kind: 'tool_result',
  toolCallId: id,
  tool: name,
  output,
  isError
});
const result = (payload: unknown): RuntimeStreamFrame => ({ kind: 'result', payload });

// ---------- agent_message ----------

test('agent_message: accumulates assistant_text', () => {
  const frames = [text('你好'), text('世界'), result({})];
  const out = framesToOutput('agent_message', frames);
  assert.equal(out.kind, 'agent_message');
  if (out.kind !== 'agent_message') return;
  assert.equal(out.content, '你好世界');
  assert.equal(out.messageKind, 'summary');
});

test('agent_message: result.payload.content overrides accumulated text', () => {
  const frames = [text('drafted'), result({ content: 'final answer' })];
  const out = framesToOutput('agent_message', frames);
  if (out.kind !== 'agent_message') return assert.fail();
  assert.equal(out.content, 'final answer');
});

test('agent_message: no text nor payload.content throws MapperError', () => {
  const frames = [result({})];
  assert.throws(() => framesToOutput('agent_message', frames), MapperError);
});

test('agent_message: payload.messageKind overrides default', () => {
  const frames = [text('hi'), result({ messageKind: 'discussion' })];
  const out = framesToOutput('agent_message', frames);
  if (out.kind !== 'agent_message') return assert.fail();
  assert.equal(out.messageKind, 'discussion');
});

// ---------- task_execution_result ----------

test('task_execution_result: baseline from payload', () => {
  const frames = [result({ summary: 'built', status: 'completed', completedItems: ['a', 'b'] })];
  const out = framesToOutput('task_execution_result', frames);
  if (out.kind !== 'task_execution_result') return assert.fail();
  assert.equal(out.status, 'completed');
  assert.equal(out.summary, 'built');
  assert.deepEqual(out.completedItems, ['a', 'b']);
});

test('task_execution_result: preserves payload.changedArtifacts', () => {
  const frames = [
    result({
      summary: 's',
      changedArtifacts: [
        {
          type: 'code_diff',
          title: 'x',
          content: 'update: x.ts',
          metadata: { fileChanges: [{ path: 'x.ts', operation: 'update' }] }
        }
      ]
    })
  ];
  const out = framesToOutput('task_execution_result', frames);
  if (out.kind !== 'task_execution_result') return assert.fail();
  assert.equal(out.changedArtifacts.length, 1);
  assert.equal(out.changedArtifacts[0].title, 'x');
});

test('task_execution_result: normalizes legacy Artifacts for Codex and Claude frames', () => {
  const frames = [
    result({
      summary: 'architecture analyzed',
      changedArtifacts: [
        {
          type: 'architecture_analysis',
          title: '项目架构分析报告',
          metadata: {
            content: '# 项目架构\n\n流式旧格式正文',
            reportKind: 'project_architecture_analysis'
          }
        },
        { type: 'mystery_report', title: 'Unknown', content: 'Must be rejected' }
      ]
    })
  ];

  const out = framesToOutput('task_execution_result', frames);
  if (out.kind !== 'task_execution_result') return assert.fail();
  assert.deepEqual(out.changedArtifacts, [
    {
      type: 'markdown',
      title: '项目架构分析报告',
      content: '# 项目架构\n\n流式旧格式正文',
      metadata: { reportKind: 'project_architecture_analysis' }
    }
  ]);
});

test('task_execution_result: derives changedArtifacts from write_file tool_results when payload lacks them', () => {
  const frames = [
    toolUse('1', 'write_file', { path: 'a.ts' }),
    toolResult('1', 'write_file', 'ok'),
    toolUse('2', 'write_file', { path: 'b.ts' }),
    toolResult('2', 'write_file', 'ok'),
    result({ summary: 'wrote two files' })
  ];
  const out = framesToOutput('task_execution_result', frames);
  if (out.kind !== 'task_execution_result') return assert.fail();
  assert.equal(out.changedArtifacts.length, 1);
  const fileChanges =
    (out.changedArtifacts[0].metadata?.fileChanges as Array<{ path: string }>) ?? [];
  assert.equal(fileChanges.length, 2);
  assert.deepEqual(
    fileChanges.map((c) => c.path),
    ['a.ts', 'b.ts']
  );
});

test('task_execution_result: default status is completed when payload omits it', () => {
  const frames = [result({ summary: 'ok' })];
  const out = framesToOutput('task_execution_result', frames);
  if (out.kind !== 'task_execution_result') return assert.fail();
  assert.equal(out.status, 'completed');
});

// ---------- other kinds baseline ----------

test('task_brief baseline', () => {
  const frames = [
    result({ goal: 'g', scope: ['s1'], acceptanceCriteria: ['ac1'], suggestedTasks: [] })
  ];
  const out = framesToOutput('task_brief', frames);
  if (out.kind !== 'task_brief') return assert.fail();
  assert.equal(out.goal, 'g');
  assert.deepEqual(out.scope, ['s1']);
});

test('task_acceptance_decision baseline', () => {
  const frames = [result({ status: 'accepted', reason: 'looks fine' })];
  const out = framesToOutput('task_acceptance_decision', frames);
  if (out.kind !== 'task_acceptance_decision') return assert.fail();
  assert.equal(out.status, 'accepted');
});

test('task_claim_decision baseline', () => {
  const frames = [result({ accepted: true, reason: 'ok' })];
  const out = framesToOutput('task_claim_decision', frames);
  if (out.kind !== 'task_claim_decision') return assert.fail();
  assert.equal(out.accepted, true);
});

test('post_review_report baseline', () => {
  const frames = [result({ isConsistentWithBrief: true, recommendation: 'deliver' })];
  const out = framesToOutput('post_review_report', frames);
  if (out.kind !== 'post_review_report') return assert.fail();
  assert.equal(out.recommendation, 'deliver');
});

test('post_review_report preserves traceable workspace-context actions', () => {
  const actions = [
    {
      action: 'request_workspace_context',
      reason: 'Review needs the implementation source before it can verify completion.',
      missingPaths: ['src/feature.ts']
    }
  ];
  const frames = [
    result({
      isConsistentWithBrief: false,
      missingItems: ['Missing source evidence for src/feature.ts.'],
      recommendation: 'ask_user',
      actions
    })
  ];

  const out = framesToOutput('post_review_report', frames);

  if (out.kind !== 'post_review_report') return assert.fail();
  assert.deepEqual(out.actions, actions);
});

test('final_delivery baseline', () => {
  const frames = [result({ summary: 'shipped' })];
  const out = framesToOutput('final_delivery', frames);
  if (out.kind !== 'final_delivery') return assert.fail();
  assert.equal(out.summary, 'shipped');
});

test('user_message_handling_plan baseline', () => {
  const frames = [
    result({
      intent: 'question',
      priority: 'normal',
      shouldPause: false,
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: 'proceed'
    })
  ];
  const out = framesToOutput('user_message_handling_plan', frames);
  if (out.kind !== 'user_message_handling_plan') return assert.fail();
  assert.equal(out.intent, 'question');
});

test('no result frame throws MapperError', () => {
  assert.throws(() => framesToOutput('agent_message', [text('hi')]), MapperError);
});
