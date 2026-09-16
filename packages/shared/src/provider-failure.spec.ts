import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderFailure, ProviderCircuit } from './provider-failure.js';

test('failure classes distinguish authentication, DNS, protocol, throttling and structured 424', () => {
  const classify = (httpStatus: number, errorCode?: string) => classifyProviderFailure({ code: 'MODEL_ERROR', message: 'failed', retryable: true,
    details: { httpStatus, errorCode, retryAfterMs: 180_000 } });
  assert.equal(classify(401).retryable, false);
  assert.equal(classify(403).failureClass, 'authentication');
  assert.equal(classify(429).retryAfterMs, 180_000);
  assert.equal(classify(502).retryable, true);
  assert.equal(classify(424).retryable, false);
  assert.equal(classify(424, 'ACCOUNT_POOL_EXHAUSTED').retryable, true);
  assert.equal(classifyProviderFailure({ code: 'MODEL_ERROR', message: 'ENOTFOUND', retryable: false }).failureClass, 'dns');
  assert.equal(classifyProviderFailure({ code: 'MODEL_ERROR', message: 'Format mismatch', retryable: true }).retryable, false);
});

test('circuits isolate connections, models and protocols, and recover after expiry', () => {
  let now = 1000;
  const circuit = new ProviderCircuit(() => now);
  const identity = { connectionId: 'one', modelId: 'model-a', protocol: 'anthropic' };
  const key = circuit.key(identity);
  const failure = { failureClass: 'authentication' as const, retryable: false };
  circuit.failed(key, failure);
  assert.equal(circuit.remaining(key), 120_000);
  for (const changed of [{ connectionId: 'two' }, { modelId: 'model-b' }, { protocol: 'responses' }]) {
    assert.equal(circuit.remaining(circuit.key({ ...identity, ...changed })), 0);
  }
  now += 120_001;
  assert.equal(circuit.remaining(key), 0);
});
