import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_OUTPUT_KINDS,
  buildStructuredOutputInstructions
} from './runtime-contracts/index.js';

test('every output kind receives root object discipline and its own header literals', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    const instructions = buildStructuredOutputInstructions(kind);
    assert.match(instructions, /STRUCTURED OUTPUT CONTRACT:/);
    assert.match(instructions, /Never wrap the result in content, output, result, payload, artifact, or metadata/);
    assert.match(instructions, /Include every required schema property and do not add undeclared root properties/);
    assert.match(instructions, /Every array property must be a JSON array, never a string or a JSON-encoded string/);
    // 2026-08-21 的失败正是缺少 schemaVersion 和 kind，两个字面值必须逐字给出。
    assert.ok(instructions.includes('schemaVersion: "1.0"'), `${kind} omitted the schemaVersion literal`);
    assert.ok(instructions.includes(`kind: "${kind}"`), `${kind} omitted its own kind literal`);
  }
});

test('tool name appears only when the Runtime submits through a provider tool', () => {
  const withTool = buildStructuredOutputInstructions('task_execution_result', {
    submissionToolName: 'StructuredOutput'
  });
  assert.match(withTool, /Pass every schema property directly as the root arguments to StructuredOutput\./);

  const withoutTool = buildStructuredOutputInstructions('task_execution_result');
  assert.match(withoutTool, /Pass every schema property directly as the root object you return\./);
  // Codex 复用同一份纪律，但它没有 StructuredOutput 工具，不能出现任何工具名。
  assert.ok(!withoutTool.includes('StructuredOutput'), 'tool-agnostic text leaked a provider tool name');
});

test('task_execution_result keeps the 2026-08-20 minimum complete shape discipline', () => {
  const instructions = buildStructuredOutputInstructions('task_execution_result', {
    submissionToolName: 'StructuredOutput'
  });
  assert.match(instructions, /directly as the root arguments to StructuredOutput/i);
  assert.match(instructions, /Never wrap the result in content, output, result, payload, artifact, or metadata/i);
  assert.match(instructions, /requestedContext is required; use null/i);
  assert.match(instructions, /agentMessages is required; use \[\]/i);
  assert.match(instructions, /nextSuggestedActions is required; use \[\]/i);
  assert.match(instructions, /changedArtifacts must be an array of artifact objects/i);
  assert.match(instructions, /Do not JSON-encode changedArtifacts or an artifact as a string/i);
  assert.match(instructions, /changedArtifacts\[\]\.content; it does not replace the task_execution_result root object/i);
});

test('task_brief forbids submitting its array fields as strings', () => {
  // 2026-08-21 09:46 的失败里，这六个数组字段全部被提交成了字符串。
  const instructions = buildStructuredOutputInstructions('task_brief');
  for (const field of ['scope', 'outOfScope', 'constraints', 'acceptanceCriteria', 'risks', 'openQuestions']) {
    assert.ok(instructions.includes(field), `task_brief discipline omitted ${field}`);
  }
  assert.match(instructions, /must each be an array of strings/);
  assert.match(instructions, /never submit these fields as a single string/);
  assert.match(instructions, /suggestedTasks must be an array of task objects, not a string/);
});

test('task acceptance instructions keep intake rejection separate from quality revision', () => {
  const instructions = buildStructuredOutputInstructions('task_acceptance_decision');
  assert.match(instructions, /intake decision, not a quality review/i);
  assert.match(instructions, /QA, test, review, or validation Agent.*must return status "accepted"/i);
  assert.match(instructions, /status "blocked" only when required context is missing/i);
  assert.match(instructions, /status "rejected" only when.*capability, role, or policy mismatch/i);
  assert.match(instructions, /fixable quality defects.*decision "revise".*non-empty revisionInstruction/i);
  assert.match(instructions, /decision "reject" only when the workflow must terminate/i);
});

test('kind specific blocks do not leak into unrelated output kinds', () => {
  const instructions = buildStructuredOutputInstructions('agent_message');
  assert.ok(!instructions.includes('For task_execution_result:'));
  assert.ok(!instructions.includes('For task_brief:'));
  assert.ok(!instructions.includes('This is an intake decision'));
});
