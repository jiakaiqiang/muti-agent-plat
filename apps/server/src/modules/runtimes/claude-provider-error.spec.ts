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

test('classifies Claude-to-OpenAI format mismatch as a permanent configuration failure', () => {
  const result = classifyClaudeProviderFailure({
    stdout: JSON.stringify({
      type: 'assistant',
      is_api_error_message: true,
      message: {
        content: [{
          type: 'text',
          text: "API Error: 400 Format mismatch: Request appears to be in format ['claude_chat'], but only [['openai_chat', 'openai_responses']] is allowed. (request id: private-request-id)"
        }]
      }
    }),
    exitCode: 1
  }, 'invocation-format');

  assert.equal(result?.code, 'MODEL_ERROR');
  assert.equal(result?.retryable, false);
  assert.equal(result?.details?.providerFailure, true);
  assert.equal(result?.details?.httpStatus, 400);
  assert.equal(result?.details?.failureKind, 'provider_format_mismatch');
  assert.equal(result?.details?.requestedFormat, 'claude_chat');
  assert.deepEqual(result?.details?.acceptedFormats, ['openai_chat', 'openai_responses']);
  assert.doesNotMatch(JSON.stringify(result), /private-request-id/);
});

test('ignores unrelated process output', () => {
  assert.equal(classifyClaudeProviderFailure({ stderr: 'update_apply_exe_locked', code: 1 }, 'invocation'), undefined);
});
