import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextAssembly, SessionDetail } from '@agent-cluster/shared';
import {
  buildBudget,
  estimateRuntimeInputTokens,
  inputTokenEstimationDrift,
  reserveInputTokenSafetyMargin
} from './token.js';

test('runtime input estimate includes context, system prompt, schema, example and extra prompt text', () => {
  const contextAssembly = { sessionGoal: 'inspect architecture' } as ContextAssembly;
  const contextOnly = estimateRuntimeInputTokens({ contextAssembly });
  const complete = estimateRuntimeInputTokens({
    contextAssembly,
    systemPrompt: 'system',
    outputSchema: { type: 'object' },
    outputExample: { ok: true },
    additionalPromptText: ['extra']
  });

  assert.ok(complete.totalTokens > contextOnly.totalTokens);
  assert.equal(
    complete.totalTokens,
    complete.contextTokens +
      complete.systemPromptTokens +
      complete.schemaTokens +
      complete.exampleTokens +
      complete.additionalPromptTokens
  );
});

test('input token safety margin reserves a configured ratio from the model limit', () => {
  assert.deepEqual(reserveInputTokenSafetyMargin(4_000, 0.1), {
    configuredMaxInputTokens: 4_000,
    effectiveMaxInputTokens: 3_600,
    safetyMarginTokens: 400,
    safetyMarginRatio: 0.1
  });
  assert.equal(reserveInputTokenSafetyMargin(undefined, 0.1).effectiveMaxInputTokens, undefined);
});

test('input token estimation drift reports only material differences', () => {
  assert.equal(inputTokenEstimationDrift(1_000, 1_100), undefined);
  assert.deepEqual(inputTokenEstimationDrift(1_000, 1_300), {
    estimated: 1_000,
    actual: 1_300,
    ratio: 1.3
  });
});

test('buildBudget splits a valid session budget and normalizes invalid input', () => {
  assert.deepEqual(buildBudget({ tokenBudget: 10_000 } as SessionDetail), {
    maxInputTokens: 7_000,
    maxOutputTokens: 2_000,
    maxTotalTokens: 10_000
  });
  assert.equal(buildBudget({ tokenBudget: 0 } as SessionDetail).maxTotalTokens, 100_000);
});
