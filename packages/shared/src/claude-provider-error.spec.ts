import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeProviderFailure } from './claude-provider-error.js';

test('classifies the full Cloudflare 524 payload as a retryable Claude timeout', () => {
  const message = 'Claude Code exited with code 1: API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/","title":"Error 524: A timeout occurred","status":524,"detail":"The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.","error_code":524,"error_name":"origin_response_timeout","error_category":"origin","ray_id":"ray-safe","zone":"gateway.example.test","retryable":true,"retry_after":120,"owner_action_required":true,"what_you_should_do":"**Wait and retry.** Back off for at least 120 seconds."}. This is a server-side issue.';

  const result = classifyClaudeProviderFailure({ message, exitCode: 1 }, 'invocation-524');

  assert.equal(result?.code, 'RUNTIME_TIMEOUT');
  assert.equal(result?.message, 'Claude model gateway timed out (HTTP 524).');
  assert.equal(result?.retryable, true);
  assert.equal(result?.details?.providerFailure, true);
  assert.equal(result?.details?.httpStatus, 524);
  assert.equal(result?.details?.retryAfterMs, 120_000);
  assert.equal(result?.details?.diagnosticRef, 'invocation-524');
  assert.equal(result?.details?.gatewayZone, 'gateway.example.test');
  assert.doesNotMatch(JSON.stringify(result), /what_you_should_do|Back off for at least/);
});
