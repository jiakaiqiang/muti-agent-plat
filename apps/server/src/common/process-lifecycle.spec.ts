import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoggerService } from '@nestjs/common';
import { createProcessLifecycleHandlers } from './process-lifecycle.js';

test('process lifecycle handlers record fatal and exit diagnostics without secrets', () => {
  const entries: Array<{ level: string; message: unknown; context?: string }> = [];
  const logger: LoggerService = {
    log(message, context) {
      entries.push({ level: 'log', message, context });
    },
    warn(message, context) {
      entries.push({ level: 'warn', message, context });
    },
    error(message, _trace, context) {
      entries.push({ level: 'error', message, context });
    }
  };
  const handlers = createProcessLifecycleHandlers(logger, () => ({ pid: 101, ppid: 55, exitCode: 1 }));

  handlers.onUncaughtException(new Error('boom'), 'unhandledRejection');
  handlers.onBeforeExit(1);
  handlers.onExit(1);

  assert.deepEqual(entries.map((entry) => entry.level), ['error', 'warn', 'log']);
  assert.equal((entries[0]?.message as { event?: string }).event, 'process_uncaught_exception');
  assert.equal((entries[2]?.message as { pid?: number }).pid, 101);
  assert.ok(entries.every((entry) => entry.context === 'ProcessLifecycle'));
});
