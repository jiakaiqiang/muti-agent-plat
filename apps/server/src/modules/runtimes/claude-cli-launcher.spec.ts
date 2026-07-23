import assert from 'node:assert/strict';
import test from 'node:test';
import { win32 } from 'node:path';
import type { RuntimeError } from '@agent-cluster/shared';
import { resolveClaudeCommand, sanitizeClaudeProcessError } from './claude-cli-launcher.js';

test('resolves the native Claude executable beside the Windows npm wrapper', () => {
  const root = 'C:\\tools';
  const wrapper = win32.join(root, 'claude.cmd');
  const native = win32.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const result = resolveClaudeCommand({
    platform: 'win32',
    env: {},
    findOnPath: (command) => command === 'claude.cmd' ? [wrapper] : [],
    exists: (path) => path === native
  });
  assert.deepEqual(result, { executable: native, source: 'native_install' });
});

test('accepts an explicitly configured native Windows executable', () => {
  const executable = 'C:\\Program Files\\Claude\\claude.exe';
  const result = resolveClaudeCommand({
    platform: 'win32',
    env: { CLAUDE_CODE_COMMAND: executable },
    findOnPath: () => [],
    exists: (path) => path === executable
  });
  assert.equal(result.executable, executable);
  assert.equal(result.source, 'configured');
});

test('uses Windows path semantics when win32 is simulated on another host platform', () => {
  const executable = 'C:\\Program Files\\Claude\\claude.exe';
  const result = resolveClaudeCommand({
    platform: 'win32',
    env: { CLAUDE_CODE_COMMAND: executable },
    findOnPath: () => [],
    exists: (candidate) => candidate === executable
  });
  assert.deepEqual(result, { executable, source: 'configured' });
});

test('rejects Windows shell wrappers for structured Runtime arguments', () => {
  assert.throws(
    () => resolveClaudeCommand({
      platform: 'win32',
      env: { CLAUDE_CODE_COMMAND: 'C:\\tools\\claude.cmd' },
      findOnPath: () => [],
      exists: () => true
    }),
    (error: unknown) => {
      const runtimeError = (error as { runtimeError?: { code?: string; retryable?: boolean } }).runtimeError;
      return runtimeError?.code === 'RUNTIME_INVOCATION_ERROR' && runtimeError.retryable === false;
    }
  );
});

test('keeps POSIX command resolution shell-free and PATH-based', () => {
  assert.deepEqual(
    resolveClaudeCommand({ platform: 'linux', env: {}, findOnPath: () => [], exists: () => false }),
    { executable: 'claude', source: 'path' }
  );
});

test('sanitizes invalid schema process failures without retaining command text or paths', () => {
  const error = sanitizeClaudeProcessError({
    code: 1,
    stderr: 'Error: --json-schema is not valid JSON at C:\\private\\workspace',
    message: 'Command failed: claude --json-schema {"type":"object"}'
  }, 'invocation-safe');
  const runtimeError = (error as { runtimeError: { message: string; details?: Record<string, unknown> } }).runtimeError;
  assert.equal(runtimeError.message, 'Claude Code rejected the Runtime invocation arguments.');
  assert.equal(runtimeError.details?.diagnosticRef, 'invocation-safe');
  assert.doesNotMatch(JSON.stringify(runtimeError), /json-schema|private|workspace/i);
});

test('preserves retryable Claude provider timeout semantics', () => {
  const error = sanitizeClaudeProcessError({
    code: 1,
    stdout: JSON.stringify({
      result: 'API Error: 524 {"status":524,"error_name":"origin_response_timeout","retryable":true,"retry_after":120}'
    })
  }, 'invocation-524');
  const runtimeError = (error as { runtimeError: RuntimeError }).runtimeError;
  assert.equal(runtimeError.code, 'RUNTIME_TIMEOUT');
  assert.equal(runtimeError.retryable, true);
  assert.equal(runtimeError.details?.retryAfterMs, 120_000);
});

test('unknown non-zero exits remain retryable model failures', () => {
  const error = sanitizeClaudeProcessError({ code: 1, stderr: 'provider unavailable' }, 'invocation-exit');
  const runtimeError = (error as { runtimeError: RuntimeError }).runtimeError;
  assert.equal(runtimeError.code, 'MODEL_ERROR');
  assert.equal(runtimeError.retryable, true);
  assert.equal(runtimeError.details?.stage, 'process_exit');
});
