import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextPipelineV2Enabled,
  engineeringRuntimeStreaming,
  llmInputSafetyMarginRatio,
  optionalRuntimeTimeoutMs,
  positiveRuntimeTimeoutMs
} from './runtime-config.js';

function withEnv(value: string | undefined, fn: () => void) {
  const previous = process.env.ENGINEERING_RUNTIME_STREAMING;
  if (value === undefined) delete process.env.ENGINEERING_RUNTIME_STREAMING;
  else process.env.ENGINEERING_RUNTIME_STREAMING = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.ENGINEERING_RUNTIME_STREAMING;
    else process.env.ENGINEERING_RUNTIME_STREAMING = previous;
  }
}

test('engineeringRuntimeStreaming: 未设置环境变量返回 off', () => {
  withEnv(undefined, () => {
    assert.equal(engineeringRuntimeStreaming(), 'off');
  });
});

test('engineeringRuntimeStreaming: 设为 codex 返回 codex', () => {
  withEnv('codex', () => {
    assert.equal(engineeringRuntimeStreaming(), 'codex');
  });
});

test('engineeringRuntimeStreaming: 设为 all 返回 all', () => {
  withEnv('all', () => {
    assert.equal(engineeringRuntimeStreaming(), 'all');
  });
});

test('engineeringRuntimeStreaming: 未知值回落到 off', () => {
  withEnv('random', () => {
    assert.equal(engineeringRuntimeStreaming(), 'off');
  });
});

test('engineeringRuntimeStreaming: 空白值回落到 off', () => {
  withEnv('   ', () => {
    assert.equal(engineeringRuntimeStreaming(), 'off');
  });
});

test('engineeringRuntimeStreaming: 大小写不敏感', () => {
  withEnv('CODEX', () => {
    assert.equal(engineeringRuntimeStreaming(), 'codex');
  });
  withEnv('ALL', () => {
    assert.equal(engineeringRuntimeStreaming(), 'all');
  });
});

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

test('llmInputSafetyMarginRatio: 未配置时提供默认安全余量', () => {
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', undefined, () => {
    assert.equal(llmInputSafetyMarginRatio(), 0.1);
  });
});

test('llmInputSafetyMarginRatio: 支持环境变量覆盖、允许关闭并回落非法值', () => {
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', '0.25', () => {
    assert.equal(llmInputSafetyMarginRatio(), 0.25);
  });
  withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', '0', () => {
    assert.equal(llmInputSafetyMarginRatio(), 0);
  });
  for (const value of ['-0.1', '1', 'invalid', 'Infinity']) {
    withNamedEnv('LLM_INPUT_SAFETY_MARGIN_RATIO', value, () => {
      assert.equal(llmInputSafetyMarginRatio(), 0.1);
    });
  }
});

test('contextPipelineV2Enabled: 未设置环境变量默认 false', () => {
  withNamedEnv('CONTEXT_PIPELINE_V2_ENABLED', undefined, () => {
    assert.equal(contextPipelineV2Enabled(), false);
  });
});

test('contextPipelineV2Enabled: truthy 值启用 v2', () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
    withNamedEnv('CONTEXT_PIPELINE_V2_ENABLED', value, () => {
      assert.equal(contextPipelineV2Enabled(), true);
    });
  }
});

test('contextPipelineV2Enabled: false 和非法值均关闭 v2', () => {
  for (const value of ['0', 'false', 'off', 'no', 'random', '   ']) {
    withNamedEnv('CONTEXT_PIPELINE_V2_ENABLED', value, () => {
      assert.equal(contextPipelineV2Enabled(), false);
    });
  }
});

test('runtime timeout helpers reject invalid values and keep absolute timeout disabled by default', () => {
  const positiveName = 'TEST_POSITIVE_RUNTIME_TIMEOUT_MS';
  const optionalName = 'TEST_OPTIONAL_RUNTIME_TIMEOUT_MS';
  const previousPositive = process.env[positiveName];
  const previousOptional = process.env[optionalName];
  try {
    delete process.env[positiveName];
    delete process.env[optionalName];
    assert.equal(positiveRuntimeTimeoutMs(positiveName, 30_000), 30_000);
    assert.equal(optionalRuntimeTimeoutMs(optionalName), undefined);

    process.env[positiveName] = '45000';
    process.env[optionalName] = '0';
    assert.equal(positiveRuntimeTimeoutMs(positiveName, 30_000), 45_000);
    assert.equal(optionalRuntimeTimeoutMs(optionalName), undefined);

    process.env[positiveName] = 'invalid';
    process.env[optionalName] = '900000';
    assert.equal(positiveRuntimeTimeoutMs(positiveName, 30_000), 30_000);
    assert.equal(optionalRuntimeTimeoutMs(optionalName), 900_000);

    process.env[positiveName] = '0.5';
    process.env[optionalName] = '2147483648';
    assert.equal(positiveRuntimeTimeoutMs(positiveName, 30_000), 30_000);
    assert.equal(optionalRuntimeTimeoutMs(optionalName), undefined);
  } finally {
    if (previousPositive === undefined) delete process.env[positiveName];
    else process.env[positiveName] = previousPositive;
    if (previousOptional === undefined) delete process.env[optionalName];
    else process.env[optionalName] = previousOptional;
  }
});
