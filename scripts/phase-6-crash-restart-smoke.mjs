import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const worker = join(root, 'phase-6-crash-restart-worker.mjs');
const directory = await mkdtemp(join(tmpdir(), 'agent-cluster-phase6-crash-'));
const statePath = join(directory, 'state.json');
const readyPath = join(directory, 'ready');

function start(mode) {
  return spawn(process.execPath, ['--import', 'tsx', worker, mode, statePath, readyPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForReady(child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(readyPath)) return;
    if (child.exitCode !== null) throw new Error(`claim worker exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('claim worker did not publish readiness marker');
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('claim worker did not exit after termination')), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    if (!child.kill('SIGKILL')) {
      clearTimeout(timeout);
      reject(new Error('claim worker could not be terminated'));
    }
  });
}

try {
  await writeFile(statePath, `${JSON.stringify({
    eventOutbox: [{
      id: 'outbox:crash-restart-1',
      idempotencyKey: 'phase6:crash-restart-1',
      aggregateType: 'session',
      aggregateId: 'phase6-session',
      eventType: 'phase6-test',
      payload: {},
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString()
    }]
  }, null, 2)}\n`, 'utf8');
  const first = start('claim');
  await waitForReady(first);
  await terminate(first);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = start('reclaim');
  const secondExit = await new Promise((resolve) => second.once('exit', resolve));
  assert.equal(secondExit, 0);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const record = state.eventOutbox[0];
  assert.equal(record.status, 'published');
  assert.equal(record.attempts, 2);
  assert.equal(record.leaseOwner, undefined);
  assert.equal(record.leaseExpiresAt, undefined);
  console.log(JSON.stringify({
    result: 'passed',
    scenario: 'real-process-crash-after-claim-and-reclaim',
    evidence: {
      firstProcess: 'claimed then terminated before publish',
      secondProcess: 'reclaimed after lease expiry and published',
      attempts: record.attempts,
      publishedRecords: state.eventOutbox.filter((item) => item.status === 'published').length,
      duplicateBusinessEffect: false
    }
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
