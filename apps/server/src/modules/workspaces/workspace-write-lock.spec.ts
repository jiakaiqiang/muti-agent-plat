import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceWriteLock } from './workspace-write-lock.js';

test('WorkspaceWriteLock serializes runs on the same path', async () => {
  const lock = new WorkspaceWriteLock();
  const events: string[] = [];
  const first = lock.run('a.ts', async () => {
    events.push('A-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('A-end');
    return 'A';
  });
  const second = lock.run('a.ts', async () => {
    events.push('B-start');
    events.push('B-end');
    return 'B';
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, 'A');
  assert.equal(secondResult, 'B');
  assert.deepEqual(events, ['A-start', 'A-end', 'B-start', 'B-end']);
});

test('WorkspaceWriteLock preserves FIFO serialization with three queued runs', async () => {
  const lock = new WorkspaceWriteLock();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = lock.run('same.txt', async () => {
    order.push('A-start');
    await firstGate;
    order.push('A-end');
  });
  const second = lock.run('same.txt', async () => {
    order.push('B-start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('B-end');
  });
  const third = lock.run('same.txt', async () => {
    order.push('C-start');
    order.push('C-end');
  });
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['A-start', 'A-end', 'B-start', 'B-end', 'C-start', 'C-end']);
});

test('WorkspaceWriteLock allows different paths to run concurrently', async () => {
  const lock = new WorkspaceWriteLock();
  const events: string[] = [];
  const first = lock.run('a.ts', async () => {
    events.push('A-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('A-end');
  });
  const second = lock.run('b.ts', async () => {
    events.push('B-start');
    events.push('B-end');
  });
  await Promise.all([first, second]);
  // B should have completed before A because there's no lock contention.
  assert.deepEqual(events, ['A-start', 'B-start', 'B-end', 'A-end']);
});

test('WorkspaceWriteLock releases the lock even when the task throws', async () => {
  const lock = new WorkspaceWriteLock();
  await assert.rejects(
    lock.run('a.ts', async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  const result = await lock.run('a.ts', async () => 'after');
  assert.equal(result, 'after');
});

test('WorkspaceWriteLock runAll acquires locks for all paths before executing', async () => {
  const lock = new WorkspaceWriteLock();
  const events: string[] = [];
  const first = lock.runAll(['a.ts', 'b.ts'], async () => {
    events.push('AB-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('AB-end');
  });
  const second = lock.run('a.ts', async () => {
    events.push('A2');
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ['AB-start', 'AB-end', 'A2']);
});
