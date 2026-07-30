import assert from 'node:assert/strict';
import test from 'node:test';
import { HeartbeatTracker } from './heartbeat-tracker.js';

function fakeClock(initial = 0) {
  let value = initial;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    }
  };
}

test('HeartbeatTracker marks a workspace online after record', () => {
  const clock = fakeClock();
  const tracker = new HeartbeatTracker(5_000, clock.now);
  tracker.record('ws-97');
  assert.equal(tracker.status('ws-97'), 'online');
});

test('HeartbeatTracker returns offline after timeout without a fresh heartbeat', () => {
  const clock = fakeClock();
  const tracker = new HeartbeatTracker(5_000, clock.now);
  tracker.record('ws-97');
  clock.advance(6_000);
  assert.equal(tracker.status('ws-97'), 'offline');
});

test('HeartbeatTracker reap returns newly offline workspaces exactly once', () => {
  const clock = fakeClock();
  const tracker = new HeartbeatTracker(1_000, clock.now);
  tracker.record('ws-a');
  tracker.record('ws-b');
  clock.advance(2_000);
  const firstReap = tracker.reap().sort();
  assert.deepEqual(firstReap, ['ws-a', 'ws-b']);
  const secondReap = tracker.reap();
  assert.deepEqual(secondReap, []);
});

test('HeartbeatTracker record within timeout keeps status online', () => {
  const clock = fakeClock();
  const tracker = new HeartbeatTracker(1_000, clock.now);
  tracker.record('ws-a');
  clock.advance(500);
  tracker.record('ws-a');
  clock.advance(700);
  assert.equal(tracker.status('ws-a'), 'online');
});

test('HeartbeatTracker drop removes an entry entirely', () => {
  const tracker = new HeartbeatTracker(1_000);
  tracker.record('ws-a');
  tracker.drop('ws-a');
  assert.equal(tracker.status('ws-a'), undefined);
});
