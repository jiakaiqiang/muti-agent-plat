import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  devWatchRoots,
  isDevWatchedPath,
  startDevWatchTriggerLogger
} from './dev-watch-scope.mjs';

test('development Watch scope includes only server and shared source directories', () => {
  const workspaceRoot = resolve('D:/platform');
  const serverRoot = resolve(workspaceRoot, 'apps/server');
  const roots = devWatchRoots(serverRoot, workspaceRoot);

  assert.equal(isDevWatchedPath(resolve(serverRoot, 'src/main.ts'), roots), true);
  assert.equal(isDevWatchedPath(resolve(workspaceRoot, 'packages/shared/src/contracts.ts'), roots), true);
  assert.equal(isDevWatchedPath(resolve(workspaceRoot, 'apps/server/dist/main.js'), roots), false);
  assert.equal(isDevWatchedPath(resolve(workspaceRoot, '.cache/browser-runtime-mirrors/file.ts'), roots), false);
  assert.equal(isDevWatchedPath(resolve('D:/business-project/src/main.ts'), roots), false);
});

test('development Watch log records the concrete trigger path and watcher identity', () => {
  const root = resolve('D:/platform/apps/server/src');
  const logs = [];
  let callback;
  const logger = startDevWatchTriggerLogger({
    roots: [root],
    pid: 4242,
    startedAt: '2026-07-24T00:00:00.000Z',
    watchDirectory(_root, _options, listener) {
      callback = listener;
      return { close() {} };
    },
    writeLog(entry) {
      logs.push(entry);
    }
  });

  callback?.('change', 'modules/runtime.ts');
  logger.close();
  assert.deepEqual(logs, [{
    eventType: 'change',
    triggerPath: resolve(root, 'modules/runtime.ts'),
    watcherPid: 4242,
    watcherStartedAt: '2026-07-24T00:00:00.000Z'
  }]);
});
