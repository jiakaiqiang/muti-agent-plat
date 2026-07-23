import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRuntimeNotification,
  isRuntimeDiagnosticEventCode,
  shouldPublishRuntimeEventToCollaboration
} from './runtime-contracts/event-policy.js';

test('workspace preparation events are diagnostic-only contract codes', () => {
  assert.equal(isRuntimeDiagnosticEventCode('WORKTREE_PREPARED'), true);
  assert.equal(isRuntimeDiagnosticEventCode('BROWSER_MIRROR_PREPARED'), true);
  assert.equal(isRuntimeDiagnosticEventCode('STREAM_TEXT'), true);
});

test('runtime event publication fails closed for debug visibility and diagnostic progress codes', () => {
  assert.equal(shouldPublishRuntimeEventToCollaboration({
    type: 'runtime_progress',
    visibility: 'debug',
    code: 'STREAM_TEXT'
  }), false);
  assert.equal(shouldPublishRuntimeEventToCollaboration({
    type: 'runtime_progress',
    visibility: 'user',
    code: 'BROWSER_MIRROR_PREPARED'
  }), false);
  assert.equal(shouldPublishRuntimeEventToCollaboration({
    type: 'runtime_progress',
    visibility: 'user',
    code: 'STREAM_TEXT'
  }), false);
  assert.equal(shouldPublishRuntimeEventToCollaboration({
    type: 'tool_completed',
    visibility: 'user',
    code: 'BROWSER_MIRROR_PREPARED'
  }), true);
});

test('MCP startup diagnostics never become authoritative Runtime failures', () => {
  assert.equal(classifyRuntimeNotification(
    'codex',
    'mcpServer/startupStatus/updated',
    { name: 'optional-server', status: 'failed', error: 'spawn EPERM' }
  ), 'debug_only');
  assert.equal(classifyRuntimeNotification(
    'codex',
    'mcpServer/startupStatus/updated',
    { status: { failed: 0, ready: 3 }, error: null }
  ), 'debug_only');
});
