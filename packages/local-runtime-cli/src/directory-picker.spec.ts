import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryPickerCommand, selectWorkspaceDirectory } from './directory-picker.js';

test('Windows directory picker uses an STA PowerShell folder dialog', () => {
  const command = directoryPickerCommand('win32', '选择目录');
  assert.equal(command.command, 'powershell.exe');
  assert.ok(command.args.includes('-STA'));
  assert.match(command.args.at(-1) ?? '', /FolderBrowserDialog/);
});

test('directory picker returns the selected path without exposing it to the platform process', async () => {
  const selected = await selectWorkspaceDirectory('Select', 'win32', async () => ({
    stdout: 'D:\\projects\\demo\r\n'
  }));
  assert.equal(selected, 'D:\\projects\\demo');
});

test('directory picker returns undefined when the user cancels', async () => {
  const selected = await selectWorkspaceDirectory('Select', 'win32', async () => ({ stdout: '' }));
  assert.equal(selected, undefined);
});

test('directory picker reports a structured timeout error', async () => {
  await assert.rejects(
    selectWorkspaceDirectory('Select', 'win32', async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    }),
    /LOCAL_DIRECTORY_PICKER_TIMEOUT/
  );
});

test('directory picker cancellation aborts only the requested picker process', async () => {
  const controller = new AbortController();
  const selection = selectWorkspaceDirectory('Select', 'win32', async (_command, _args, signal) => {
    return await new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
      }, { once: true });
    });
  }, controller.signal);

  controller.abort();
  assert.equal(await selection, undefined);
});
