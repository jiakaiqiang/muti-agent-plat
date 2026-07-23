import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  LivenessWatchdog,
  type WatchdogReason,
  type WatchdogTimeoutObservation
} from './liveness-watchdog.js';

function makeCollector() {
  const calls: WatchdogReason[] = [];
  return { calls, onTimeout: (r: WatchdogReason) => calls.push(r) };
}

test('watchdog does nothing before start()', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  mock.timers.tick(60_000);
  assert.deepEqual(c.calls, []);
  mock.timers.reset();
});

test('first_frame timeout fires when no frame arrives', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  mock.timers.tick(30_000);
  assert.deepEqual(c.calls, ['first_frame']);
  mock.timers.reset();
});

test('first_frame cleared when notifyFrame arrives before deadline', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  mock.timers.tick(20_000);
  wd.notifyFrame();
  mock.timers.tick(30_000);
  assert.deepEqual(c.calls, []); // first_frame 未触发,idle 未启用
  mock.timers.reset();
});

test('stop() prevents any subsequent timeout', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  wd.stop();
  mock.timers.tick(100_000);
  assert.deepEqual(c.calls, []);
  mock.timers.reset();
});

test('idle timeout fires after first frame + inactivity', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  mock.timers.tick(20_000);
  wd.notifyFrame();
  mock.timers.tick(60_000);
  assert.deepEqual(c.calls, ['idle']);
  mock.timers.reset();
});

test('idle is refreshed by each subsequent frame', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  wd.notifyFrame(); // 首帧
  for (let i = 0; i < 4; i += 1) {
    mock.timers.tick(30_000);
    wd.notifyFrame();
  }
  mock.timers.tick(30_000); // 距离最后一帧 30s,不到 60s idle
  assert.deepEqual(c.calls, []);
  mock.timers.reset();
});

test('idle does not fire before first frame arrives', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 300_000,
    idleTimeoutMs: 60_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  mock.timers.tick(65_000);
  assert.deepEqual(c.calls, []); // 首帧未到,idle 不应启用
  mock.timers.reset();
});

test('idleTimeoutMs omitted disables idle entirely', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  wd.notifyFrame();
  mock.timers.tick(3_600_000);
  assert.deepEqual(c.calls, []);
  mock.timers.reset();
});

test('absolute timeout fires regardless of activity', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
    absoluteTimeoutMs: 90_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  mock.timers.tick(20_000);
  wd.notifyFrame();
  mock.timers.tick(40_000); // 60s,idle 未到
  wd.notifyFrame();
  mock.timers.tick(30_000); // 累计 90s,absolute 触发
  assert.deepEqual(c.calls, ['absolute']);
  mock.timers.reset();
});

test('absolute timeout disabled by default', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  wd.notifyFrame();
  mock.timers.tick(24 * 3600 * 1000);
  assert.deepEqual(c.calls, []);
  mock.timers.reset();
});

test('stop() is idempotent', () => {
  const c = makeCollector();
  const wd = new LivenessWatchdog({ firstFrameTimeoutMs: 30_000, onTimeout: c.onTimeout });
  wd.start();
  wd.stop();
  wd.stop();
  wd.stop();
  assert.deepEqual(c.calls, []);
});

test('onTimeout fires exactly once per watchdog lifecycle', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
    absoluteTimeoutMs: 90_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  mock.timers.tick(30_000); // first_frame 触发
  mock.timers.tick(60_000); // idle 若还挂着会触发,应已被 stop
  mock.timers.tick(60_000); // absolute 若还挂着也会触发
  assert.deepEqual(c.calls, ['first_frame']);
  mock.timers.reset();
});

test('diagnostic frames clear first-frame timeout without extending idle timeout', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 500,
    idleTimeoutMs: 1_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  mock.timers.tick(200);
  wd.notifyFrame(false);
  mock.timers.tick(900);
  wd.notifyFrame(false);
  mock.timers.tick(100);
  assert.deepEqual(c.calls, ['idle']);
  mock.timers.reset();
});

test('meaningful activity refreshes idle after an initial diagnostic frame', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = makeCollector();
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 500,
    idleTimeoutMs: 1_000,
    onTimeout: c.onTimeout
  });
  wd.start();
  wd.notifyFrame(false);
  mock.timers.tick(900);
  wd.notifyFrame(true);
  mock.timers.tick(999);
  assert.deepEqual(c.calls, []);
  mock.timers.tick(1);
  assert.deepEqual(c.calls, ['idle']);
  mock.timers.reset();
});

test('timeout observation records threshold, last activity and elapsed time', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let current = 1_000;
  let observation: WatchdogTimeoutObservation | undefined;
  const wd = new LivenessWatchdog({
    firstFrameTimeoutMs: 500,
    idleTimeoutMs: 1_000,
    now: () => current,
    onTimeout: (_reason, value) => {
      observation = value;
    }
  });
  wd.start();
  current = 1_200;
  wd.notifyFrame();
  current = 2_200;
  mock.timers.tick(1_000);
  assert.deepEqual(observation, {
    reason: 'idle',
    thresholdMs: 1_000,
    startedAtMs: 1_000,
    lastActivityAtMs: 1_200,
    timedOutAtMs: 2_200,
    elapsedMs: 1_200,
    idleForMs: 1_000,
    firstFrameSeen: true
  });
  mock.timers.reset();
});
