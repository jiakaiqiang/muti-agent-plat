import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSessionCreateContract } from './sessions.controller.js';

test('Session create accepts only the v2 request surface', () => {
  assert.doesNotThrow(() =>
    assertSessionCreateContract({
      input: 'analyze the architecture',
      runtimePreference: { preferredRuntimeType: 'codex' }
    })
  );
});

test('Session create rejects legacy routing and context fields instead of ignoring them', () => {
  for (const field of ['runtimeType', 'modelId', 'executionTarget', 'contextAssembly', 'pipelineVersion']) {
    assert.throws(
      () => assertSessionCreateContract({ input: 'analyze', [field]: 'legacy-value' }),
      /Unsupported Session create fields/
    );
  }
});
