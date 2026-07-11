import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeOptions } from './build-resume-options.js';

test('M4-03: task_execution + prior invocation → options.resume set', () => {
  const options = buildResumeOptions('task_execution', {
    cliSessionId: 'cli-123',
    workDir: '/prior'
  });
  assert.deepEqual(options, {
    resume: { cliSessionId: 'cli-123', workDir: '/prior' }
  });
});

test('M4-03: task_execution + no prior invocation → undefined', () => {
  assert.equal(buildResumeOptions('task_execution', undefined), undefined);
});

test('M4-03: task_execution + empty prior refs → undefined', () => {
  assert.equal(buildResumeOptions('task_execution', {}), undefined);
});

test('M4-03: non-task_execution phase → undefined', () => {
  const options = buildResumeOptions('brief_generation', {
    cliSessionId: 'cli-999',
    workDir: '/fake'
  });
  assert.equal(options, undefined);
});

test('M4-03: discussion phase → undefined', () => {
  const options = buildResumeOptions('discussion', {
    cliSessionId: 'cli-x',
    workDir: '/x'
  });
  assert.equal(options, undefined);
});

test('M4-03: task_execution + only cliSessionId → options.resume set', () => {
  const options = buildResumeOptions('task_execution', { cliSessionId: 'cli-only' });
  assert.deepEqual(options, {
    resume: { cliSessionId: 'cli-only', workDir: undefined }
  });
});

test('M4-03: task_execution + only workDir → options.resume set', () => {
  const options = buildResumeOptions('task_execution', { workDir: '/only' });
  assert.deepEqual(options, {
    resume: { cliSessionId: undefined, workDir: '/only' }
  });
});
