import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForDesktopWindow } from './dev-desktop.mjs';

const serverUrl = 'http://127.0.0.1:8099';
test('a spawned process without a visible-window receipt is not successful startup', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-launch-timeout-'));
  // Even code=0 might be a stale single-instance handoff; require the actual window.
  await assert.rejects(waitForDesktopWindow({ profile, launchId: 'missing', serverUrl, child: { exitCode: 0 }, timeoutMs: 1 }), /did not confirm a visible window/);
});

test('visible-window acknowledgment must match the requested backend', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-launch-receipt-'));
  for (const [name, result] of [
    ['hidden', { status: 'ready', serverUrl, visible: false }],
    ['wrong-platform', { status: 'ready', serverUrl: 'https://example.com', visible: true }],
    ['failed', { status: 'error', error: 'Preload failed' }]
  ]) {
    await writeFile(join(profile, `dev-launch-${name}.json`), JSON.stringify(result));
    await assert.rejects(waitForDesktopWindow({ profile, launchId: name, serverUrl, child: { exitCode: null } }));
  }
  const receipt = join(profile, 'dev-launch-valid.json');
  await writeFile(receipt, JSON.stringify({ status: 'ready', serverUrl, visible: true, pid: 123 }));
  assert.equal((await waitForDesktopWindow({ profile, launchId: 'valid', serverUrl, child: { exitCode: null } })).pid, 123);
  await assert.rejects(access(receipt), { code: 'ENOENT' });
});

test('an Electron crash is reported before waiting for the full timeout', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-launch-crash-'));
  await assert.rejects(waitForDesktopWindow({ profile, launchId: 'crashed', serverUrl, child: { exitCode: 1 } }), /exited before opening a window/);
});
