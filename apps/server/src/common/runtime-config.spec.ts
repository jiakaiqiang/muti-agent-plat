import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discussionTimeoutMs,
  phaseTimeoutMs,
  globalDefaultRuntimeType,
  llmInputSafetyMarginRatio,
  optionalRuntimeTimeoutMs,
  positiveRuntimeTimeoutMs,
  projectPolicyRuntimeType,
  runtimeStreamingMode,
  workItemBudgetEnforcementEnabled
} from './runtime-config.js';

function withNamedEnv(name: string, value: string | undefined, fn: () => void) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function withStreaming(value: string | undefined, fn: () => void) {
  withNamedEnv('RUNTIME_STREAMING', value, fn);
}

test('runtimeStreamingMode defaults to off', () => {
  withStreaming(undefined, () => assert.equal(runtimeStreamingMode(), 'off'));
});

test('runtimeStreamingMode accepts codex', () => {
  withStreaming('codex', () => assert.equal(runtimeStreamingMode(), 'codex'));
});

test('runtimeStreamingMode accepts all', () => {
  withStreaming('all', () => assert.equal(runtimeStreamingMode(), 'all'));
});

test('runtimeStreamingMode rejects unknown and blank values', () => {
  withStreaming('random', () => assert.equal(runtimeStreamingMode(), 'off'));
  withStreaming('  ', () => assert.equal(runtimeStreamingMode(), 'off'));
});

test('runtimeStreamingMode is case insensitive', () => {
  withStreaming('CODEX', () => assert.equal(runtimeStreamingMode(), 'codex'));
  withStreaming('ALL', () => assert.equal(runtimeStreamingMode(), 'all'));
});

test('globalDefaultRuntimeType reads only the v2 global default', () => {
  withNamedEnv('GLOBAL_DEFAULT_RUNTIME_TYPE', 'codex', () => assert.equal(globalDefaultRuntimeType(), 'codex'));
});

test('globalDefaultRuntimeType fails invalid configuration back to generic_llm', () => {
  withNamedEnv('GLOBAL_DEFAULT_RUNTIME_TYPE', 'invalid', () => assert.equal(globalDefaultRuntimeType(), 'generic_llm'));
});

test('projectPolicyRuntimeType is optional and validates RuntimeType', () => {
  withNamedEnv('PROJECT_POLICY_RUNTIME_TYPE', undefined, () => assert.equal(projectPolicyRuntimeType(), undefined));
  withNamedEnv('PROJECT_POLICY_RUNTIME_TYPE', 'claude_code', () => assert.equal(projectPolicyRuntimeType(), 'claude_code'));
  withNamedEnv('PROJECT_POLICY_RUNTIME_TYPE', 'invalid', () => assert.equal(projectPolicyRuntimeType(), undefined));
});

test('WorkItem cumulative token budget enforcement is opt-in', () => {
  withNamedEnv('AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT', undefined, () => {
    assert.equal(workItemBudgetEnforcementEnabled(), false);
  });
  withNamedEnv('AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT', 'true', () => {
    assert.equal(workItemBudgetEnforcementEnabled(), true);
  });
  withNamedEnv('AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT', 'false', () => {
    assert.equal(workItemBudgetEnforcementEnabled(), false);
  });
});

test('llmInputSafetyMarginRatio provides a safe default', () => {
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', undefined, () => assert.equal(llmInputSafetyMarginRatio(), 0.1));
});

test('llmInputSafetyMarginRatio accepts bounded overrides and rejects invalid values', () => {
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', '0.25', () => assert.equal(llmInputSafetyMarginRatio(), 0.25));
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', '0', () => assert.equal(llmInputSafetyMarginRatio(), 0));
  for (const value of ['-0.1', '1', 'invalid', 'Infinity']) {
    withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', value, () => assert.equal(llmInputSafetyMarginRatio(), 0.1));
  }
});

test('discussionTimeoutMs delegates timeout ownership to the runtime by default', () => {
  withNamedEnv('DISCUSSION_TIMEOUT_MS', undefined, () => assert.equal(discussionTimeoutMs(), 0));
  withNamedEnv('DISCUSSION_TIMEOUT_MS', '0', () => assert.equal(discussionTimeoutMs(), 0));
  withNamedEnv('DISCUSSION_TIMEOUT_MS', '60000', () => assert.equal(discussionTimeoutMs(), 60_000));
  for (const value of ['-1', 'invalid', 'Infinity']) {
    withNamedEnv('DISCUSSION_TIMEOUT_MS', value, () => assert.equal(discussionTimeoutMs(), 0));
  }
});

test('phaseTimeoutMs supports per-phase policies and preserves the discussion compatibility key', () => {
  withNamedEnv('DISCUSSION_TIMEOUT_MS', '60000', () => {
    withNamedEnv('PHASE_TIMEOUT_DISCUSSION_MS', undefined, () => assert.equal(phaseTimeoutMs('discussion'), 60_000));
  });
  withNamedEnv('PHASE_TIMEOUT_TASK_EXECUTION_MS', '90000', () => {
    assert.equal(phaseTimeoutMs('task_execution'), 90_000);
  });
  withNamedEnv('PHASE_TIMEOUT_FINAL_DELIVERY_MS', undefined, () => {
    assert.equal(phaseTimeoutMs('final_delivery'), 0);
  });
});

test('positiveRuntimeTimeoutMs rejects invalid values', () => {
  withNamedEnv('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', undefined, () => {
    assert.equal(positiveRuntimeTimeoutMs('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', 30_000), 30_000);
  });
  withNamedEnv('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', '45000', () => {
    assert.equal(positiveRuntimeTimeoutMs('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', 30_000), 45_000);
  });
  for (const value of ['invalid', '0.5', '2147483648']) {
    withNamedEnv('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', value, () => {
      assert.equal(positiveRuntimeTimeoutMs('TEST_POSITIVE_RUNTIME_TIMEOUT_MS', 30_000), 30_000);
    });
  }
});

test('optionalRuntimeTimeoutMs stays disabled by default and validates bounds', () => {
  withNamedEnv('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS', undefined, () => {
    assert.equal(optionalRuntimeTimeoutMs('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS'), undefined);
  });
  withNamedEnv('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS', '900000', () => {
    assert.equal(optionalRuntimeTimeoutMs('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS'), 900_000);
  });
  for (const value of ['0', 'invalid', '2147483648']) {
    withNamedEnv('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS', value, () => {
      assert.equal(optionalRuntimeTimeoutMs('TEST_OPTIONAL_RUNTIME_TIMEOUT_MS'), undefined);
    });
  }
});
