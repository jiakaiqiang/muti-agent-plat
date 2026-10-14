import test from 'node:test';
import assert from 'node:assert/strict';
import { canAutomaticallyFailover, confirmedRuntimeExit } from './runtime-failover-policy.js';
import type { AgentRunResult, RuntimeError } from './contracts.js';

test('only confirmed process exit or a retryable provider fault authorizes automatic failover', () => {
  const result = (error: RuntimeError) => ({ status: 'failed', error } as AgentRunResult);
  const crash = confirmedRuntimeExit({ code: 'MODEL_ERROR', message: 'process exited', retryable: false }, 137);
  assert.equal(canAutomaticallyFailover(result(crash)), true);
  assert.equal(canAutomaticallyFailover(result({ code: 'MODEL_ERROR', message: 'unknown error', retryable: true })), false);
  assert.equal(canAutomaticallyFailover(result({ ...crash, details: { ...crash.details, stopUnconfirmed: true } })), false);
  assert.equal(canAutomaticallyFailover(result({ ...crash, details: { ...crash.details, operationFailure: 'OPERATION_BUDGET_EXHAUSTED' } })), false);
  assert.equal(canAutomaticallyFailover({ ...result(crash), status: 'cancelled' }), false);
  assert.equal(canAutomaticallyFailover(result(confirmedRuntimeExit({ code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION', message: 'invalid output', retryable: false }, 1))), false);
  assert.equal(canAutomaticallyFailover(result({ code: 'MODEL_ERROR', message: 'rate limited', retryable: true, details: { providerFailure: true } })), true);
});
