import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { PersistenceService } from './persistence.service.js';

test('default file persistence is anchored to the loaded environment root, not the workspace process cwd', () => {
  const previousEnvDir = process.env.AGENT_CLUSTER_ENV_DIR;
  const previousDataDir = process.env.AGENT_CLUSTER_DATA_DIR;
  const previousDataFile = process.env.AGENT_CLUSTER_DATA_FILE;
  const root = resolve('test-environment-root');
  try {
    process.env.AGENT_CLUSTER_ENV_DIR = root;
    delete process.env.AGENT_CLUSTER_DATA_DIR;
    delete process.env.AGENT_CLUSTER_DATA_FILE;
    const persistence = new PersistenceService({ enabled: false });
    assert.equal(persistence.dataFilePath(), join(root, '.cache', 'agent-cluster', 'state.v3.json'));
  } finally {
    restoreEnv('AGENT_CLUSTER_ENV_DIR', previousEnvDir);
    restoreEnv('AGENT_CLUSTER_DATA_DIR', previousDataDir);
    restoreEnv('AGENT_CLUSTER_DATA_FILE', previousDataFile);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
