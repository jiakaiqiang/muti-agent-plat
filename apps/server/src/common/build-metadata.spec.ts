import test from 'node:test';
import assert from 'node:assert/strict';
import { captureRuntimeBuildMonitor, resolveBuildCommit } from './build-metadata.js';

test('build commit prefers explicitly configured deployment metadata', () => {
  let gitCalled = false;
  const commit = resolveBuildCommit(
    { AGENT_CLUSTER_COMMIT: 'release-commit' },
    () => {
      gitCalled = true;
      return 'local-commit';
    }
  );

  assert.equal(commit, 'release-commit');
  assert.equal(gitCalled, false);
});

test('build commit falls back to the local git revision and dirty state', () => {
  const calls: string[][] = [];
  const commit = resolveBuildCommit({}, (args) => {
    calls.push(args);
    return args[0] === 'rev-parse' ? 'd8f1208\n' : ' M apps/server/src/main.ts\n';
  });

  assert.equal(commit, 'd8f1208-dirty');
  assert.deepEqual(calls, [
    ['rev-parse', '--short=7', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=normal']
  ]);
});

test('build commit remains unknown outside a git checkout', () => {
  assert.equal(resolveBuildCommit({}, () => undefined), 'unknown');
});

test('runtime build monitor marks a dist process stale after rebuilt JavaScript appears', () => {
  const modifiedTimes = [1_000, 2_000];
  const monitor = captureRuntimeBuildMonitor({
    env: { AGENT_CLUSTER_COMMIT: 'abc1234' },
    entryPath: 'D:\\project\\dist\\apps\\server\\src\\main.js',
    latestModifiedAt: () => modifiedTimes.shift()
  });

  assert.equal(monitor.buildTime, new Date(1_000).toISOString());
  assert.equal(monitor.buildId, `abc1234:${new Date(1_000).toISOString()}`);
  assert.equal(monitor.runtimeBuildStale(), true);
  assert.equal(monitor.runtimeBuildStale(), true, 'stale state is sticky');
});

test('runtime build monitor does not inspect dist for a source-mode process', () => {
  let scans = 0;
  const monitor = captureRuntimeBuildMonitor({
    env: { AGENT_CLUSTER_COMMIT: 'dev', AGENT_CLUSTER_BUILD_TIME: '2026-07-31T00:00:00.000Z' },
    entryPath: 'D:\\project\\apps\\server\\scripts\\dev.mjs',
    latestModifiedAt: () => { scans += 1; return 1_000; }
  });

  assert.equal(monitor.runtimeBuildStale(), false);
  assert.equal(scans, 0);
});
