import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateController } from './update-controller';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  installed = 0;
  async checkForUpdates() { this.emit('update-available', { version: '0.2.0' }); }
  async downloadUpdate() { this.emit('update-downloaded', { version: '0.2.0' }); }
  quitAndInstall() { this.installed++; }
}
test('download never exits; busy helper prevents installation and permits retry after idle', async () => {
  const updater = new FakeUpdater();
  let busy = true;
  let quits = 0;
  const controller = new UpdateController(updater, true, async () => { if (busy) throw new Error('busy'); }, allowed => { if (allowed) quits++; });
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await controller.check();
  await controller.download();
  assert.equal(updater.installed, 0);
  await assert.rejects(() => controller.install(), /busy/);
  assert.equal(updater.installed, 0);
  assert.equal(quits, 0);
  assert.equal(controller.status.state, 'downloaded');
  busy = false;
  await controller.install();
  assert.equal(updater.installed, 1);
  assert.equal(quits, 1);
});
test('missing feed and download failures cannot invoke installation', async () => {
  const updater = new FakeUpdater();
  const disabled = new UpdateController(updater, false, async () => {}, () => {});
  await assert.rejects(() => disabled.check(), /更新源/);
  await assert.rejects(() => disabled.install(), /下载/);
  assert.equal(updater.installed, 0);
  const controller = new UpdateController(new FakeUpdater(), true, async () => {}, () => {});
  await assert.rejects(() => controller.install(), /下载/);
  const broken = new FakeUpdater();
  broken.downloadUpdate = async () => { throw new Error('download disconnected'); };
  const failed = new UpdateController(broken, true, async () => {}, () => {});
  await failed.check();
  await assert.rejects(() => failed.download(), /disconnected/);
  assert.equal(failed.status.state, 'error');
  await assert.rejects(() => failed.install(), /下载/);
  assert.equal(broken.installed, 0);
});
test('concurrent install clicks use one handshake and one installer', async () => {
  const updater = new FakeUpdater();
  let release!: () => void;
  const controller = new UpdateController(updater, true, () => new Promise(resolve => { release = resolve; }), () => {});
  await controller.check(); await controller.download();
  const first = controller.install();
  await controller.install();
  assert.equal(updater.installed, 0);
  release(); await first;
  assert.equal(updater.installed, 1);
});
