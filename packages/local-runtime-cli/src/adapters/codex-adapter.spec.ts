import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCodexProcessFailure } from './codex-adapter.js';

test('Codex failure reports the structured stdout error when stderr is empty', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }),
    JSON.stringify({ type: 'error', message: 'stream disconnected before completion' })
  ].join('\n');
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(message, 'Codex exited with code 1: stream disconnected before completion');
});

test('Codex failure reads a nested error object with its code', () => {
  const stdout = JSON.stringify({
    type: 'turn.failed',
    error: { code: 'context_length_exceeded', message: 'request exceeds the context window' }
  });
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(
    message,
    'Codex exited with code 1: request exceeds the context window (context_length_exceeded)'
  );
});

test('Codex failure unwraps an error carried inside a completed item', () => {
  const stdout = JSON.stringify({
    type: 'item.completed',
    item: { type: 'error', message: 'sandbox denied the write' }
  });
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(message, 'Codex exited with code 1: sandbox denied the write');
});

test('Codex failure keeps the last reported stream error when several arrive', () => {
  const stdout = [
    JSON.stringify({ type: 'error', message: 'first retryable hiccup' }),
    JSON.stringify({ type: 'error', message: 'final fatal error' })
  ].join('\n');
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(message, 'Codex exited with code 1: final fatal error');
});

test('Codex failure surfaces a provider outage recorded in a task_complete payload', () => {
  // 取自 2026-08-11 13:34 的真实 rollout:错误嵌在 payload.error 里,last_agent_message 为 null。
  const stdout = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: null,
      error: {
        message: 'unexpected status 424 Failed Dependency: Upstream request failed, url: https://api.example.test/v1/responses',
        codex_error_info: 'other'
      }
    }
  });
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(
    message,
    'Codex exited with code 1: unexpected status 424 Failed Dependency: Upstream request failed, url: https://api.example.test/v1/responses'
  );
});

test('Codex failure prefers a structured stdout error over stderr noise', () => {
  const stdout = JSON.stringify({ type: 'error', message: 'schema rejected by provider' });
  const message = formatCodexProcessFailure(stdout, 'warning: deprecated flag\n', 1);
  assert.equal(message, 'Codex exited with code 1: schema rejected by provider');
});

test('Codex failure falls back to stderr when stdout carries no error frame', () => {
  const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'th_1' });
  const message = formatCodexProcessFailure(stdout, 'codex: command failed\n', 1);
  assert.equal(message, 'Codex exited with code 1: codex: command failed');
});

test('Codex failure falls back to the last stdout line when both other sources are empty', () => {
  const message = formatCodexProcessFailure('starting codex\nunexpected end of stream\n', '', 1);
  assert.equal(message, 'Codex exited with code 1: unexpected end of stream');
});

test('Codex failure stays readable when the process reports nothing at all', () => {
  const message = formatCodexProcessFailure('', '', 1);
  assert.equal(message, 'Codex exited with code 1.');
});

test('Codex failure truncates an oversized detail to the trailing 4000 characters', () => {
  const stdout = JSON.stringify({ type: 'error', message: 'x'.repeat(5000) });
  const message = formatCodexProcessFailure(stdout, '', 1);
  assert.equal(message, `Codex exited with code 1: ${'x'.repeat(4000)}`);
});

test('Codex failure reports a null exit code without inventing one', () => {
  const message = formatCodexProcessFailure('', 'killed by signal\n', null);
  assert.equal(message, 'Codex exited with code null: killed by signal');
});
