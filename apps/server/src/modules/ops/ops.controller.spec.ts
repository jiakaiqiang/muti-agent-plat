import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsController } from './ops.controller.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('health exposes build time, commit and effective pipeline version', () => {
  withEnv(
    {
      AGENT_CLUSTER_BUILD_TIME: '2026-07-11T02:00:00.000Z',
      AGENT_CLUSTER_COMMIT: 'abc1234',
      CONTEXT_PIPELINE_V2_ENABLED: 'true'
    },
    () => {
      const response = new OpsController().health();

      assert.equal(response.data.buildTime, '2026-07-11T02:00:00.000Z');
      assert.equal(response.data.commit, 'abc1234');
      assert.equal(response.data.pipelineVersion, 'v2');
    }
  );
});
