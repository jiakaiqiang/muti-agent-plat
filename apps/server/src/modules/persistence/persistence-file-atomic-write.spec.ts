import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { PersistenceService, replaceFileWithRetry } from './persistence.service.js';

test('file persistence ignores a stale PID temp file and leaves no new temp artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-atomic-write-'));
  const filePath = join(directory, 'state.v3.json');
  const staleTemp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staleTemp, 'stale interrupted write');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  try {
    await persistence.initialize();
    persistence.setCollection('value', { current: true });
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).value, { current: true });
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
      [basename(staleTemp)]
    );
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file persistence retries transient Windows replacement failures without dropping the new state', () => {
  let attempts = 0;
  replaceFileWithRetry('temporary-state', 'state.v3.json', () => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error('destination is temporarily locked'), { code: 'EPERM' });
    }
  }, 4);
  assert.equal(attempts, 3);
});

test('file persistence does not retry non-transient replacement failures', () => {
  let attempts = 0;
  assert.throws(
    () => replaceFileWithRetry('temporary-state', 'state.v3.json', () => {
      attempts += 1;
      throw Object.assign(new Error('invalid destination'), { code: 'EINVAL' });
    }),
    /invalid destination/
  );
  assert.equal(attempts, 1);
});
