import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildCommit } from './build-metadata.js';

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
