import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeProviderFailure } from './claude-provider-error.js';

test('classifies Cloudflare 524 as a retryable provider timeout', () => {
  const result = classifyClaudeProviderFailure({
    stdout: JSON.stringify({
      is_error: true,
      result: 'API Error: 524 {"status":524,"error_name":"origin_response_timeout","error_category":"origin","zone":"api.picpi.top","ray_id":"ray-safe","retryable":true,"retry_after":120}. Try again.'
    }),
    code: 1
  }, 'invocation-524');

  assert.equal(result?.code, 'RUNTIME_TIMEOUT');
  assert.equal(result?.retryable, true);
  assert.equal(result?.details?.httpStatus, 524);
  assert.equal(result?.details?.retryAfterMs, 120_000);
  assert.equal(result?.details?.providerFailure, true);
  assert.equal(result?.details?.stage, 'provider_response');
  assert.equal(result?.details?.gatewayZone, 'api.picpi.top');
  assert.equal(result?.details?.rayId, 'ray-safe');
  assert.doesNotMatch(JSON.stringify(result), /Try again/);
});

test('classifies authentication errors as permanent provider failures', () => {
  const result = classifyClaudeProviderFailure({
    stderr: 'API Error: 401 {"status":401,"retryable":false}',
    exitCode: 1
  }, 'invocation-401');

  assert.equal(result?.code, 'MODEL_ERROR');
  assert.equal(result?.retryable, false);
  assert.equal(result?.details?.httpStatus, 401);
});

test('ignores unrelated process output', () => {
  assert.equal(classifyClaudeProviderFailure({ stderr: 'update_apply_exe_locked', code: 1 }, 'invocation'), undefined);
});
