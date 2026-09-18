import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRuntimeError, isRuntimeError } from './runtime-error.js';

test('recognizes work-item budget exhaustion as a structured runtime error', () => {
  const runtimeError = {
    code: 'WORK_ITEM_BUDGET_EXHAUSTED' as const,
    message: '当前需求的累计模型预算已不足。',
    retryable: false
  };

  assert.equal(isRuntimeError(runtimeError), true);
  assert.deepEqual(
    extractRuntimeError(Object.assign(new Error(runtimeError.message), { cause: runtimeError })),
    runtimeError
  );
});
