import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeCommand } from './runtime-process.js';

test('cancelling an invocation closes its real child before returning a result', async () => {
  const controller = new AbortController();
  let pid = 0;
  const result = await runRuntimeCommand({
    command: process.execPath,
    args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000);'],
    stdin: '', cwd: process.cwd(), signal: controller.signal,
    onStdoutLine: line => { pid = Number(line); controller.abort(); }
  });
  assert.ok(pid > 0);
  assert.equal(controller.signal.aborted, true);
  assert.notEqual(result.exitCode, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
