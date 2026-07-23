import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunPhase } from '@agent-cluster/shared';
import { smartRuntimePick } from './smart-runtime-pick.js';

const nonExecutionPhases: AgentRunPhase[] = [
  'discussion',
  'brief_generation',
  'brief_revision',
  'task_acceptance',
  'post_review',
  'final_delivery',
  'user_message_routing'
];

test('non task_execution phases always pick generic_llm regardless of requiresCodeChanges', () => {
  for (const phase of nonExecutionPhases) {
    assert.equal(smartRuntimePick({ phase, requiresCodeChanges: true }), 'generic_llm', `${phase} + code changes`);
    assert.equal(smartRuntimePick({ phase, requiresCodeChanges: false }), 'generic_llm', `${phase} + no code changes`);
  }
});

test('task_execution with code changes picks codex', () => {
  assert.equal(smartRuntimePick({ phase: 'task_execution', requiresCodeChanges: true }), 'codex');
});

test('task_execution without code changes picks code_reader', () => {
  assert.equal(smartRuntimePick({ phase: 'task_execution', requiresCodeChanges: false }), 'code_reader');
});
