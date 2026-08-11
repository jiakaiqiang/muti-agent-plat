import assert from 'node:assert/strict';
import test from 'node:test';
import { matchExactUserCommand } from '../intent-recognition/deterministic-command-guard.service.js';
import { resolveExactCommand } from './command-state-resolver.service.js';

test('resolves continue against a unique resumable confirmation', () => {
  const command = matchExactUserCommand('继续');
  assert.ok(command);
  const resolution = resolveExactCommand({
    command,
    sessionStatus: 'WAIT_USER_DECISION',
    pendingConfirmation: {
      confirmationId: 'confirmation-1',
      reason: 'coordinator_routing_needs_user_decision',
      content: '请选择下一步。',
      options: [{ key: 'resume', label: '继续执行' }, { key: 'cancel', label: '取消' }],
      createdAt: '2026-08-11T00:00:00.000Z'
    }
  });
  assert.deepEqual(resolution, {
    action: 'resume_session',
    message: '已收到继续指令，正在恢复当前任务。',
    confirmationId: 'confirmation-1'
  });
});

test('does not resolve structured or high-risk confirmations from generic chat', () => {
  const command = matchExactUserCommand('确认');
  assert.ok(command);
  const resolution = resolveExactCommand({
    command,
    sessionStatus: 'WAIT_USER_DECISION',
    pendingConfirmation: {
      confirmationId: 'permission-1',
      reason: 'approve_local_runtime_permission',
      content: '确认本机危险动作。',
      options: [{ key: 'approve_once', label: '仅本次允许' }],
      createdAt: '2026-08-11T00:00:00.000Z'
    }
  });
  assert.equal(resolution.action, 'clarify');
});

test('acknowledges continue while execution is already active', () => {
  const command = matchExactUserCommand('continue');
  assert.ok(command);
  assert.equal(resolveExactCommand({ command, sessionStatus: 'EXECUTING' }).action, 'acknowledge');
});

test('retries a failed workflow that is waiting for user decision', () => {
  const command = matchExactUserCommand('重试');
  assert.ok(command);
  assert.equal(resolveExactCommand({
    command,
    sessionStatus: 'WAIT_USER_DECISION',
    hasFailedWorkflowRun: true
  }).action, 'retry_current');
});
