import type { UpdateStatus } from './contracts';

export type UpdateStatusListener = (status: UpdateStatus) => void;

export type Updater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};
export class UpdateController {
  status: UpdateStatus;
  private installing = false;
  private readonly listeners = new Set<UpdateStatusListener>();
  constructor(private updater: Updater, private enabled: boolean, private stopRuntime: () => Promise<void>, private permitQuit: (allowed: boolean) => void) {
    this.status = { state: enabled ? 'idle' : 'unconfigured' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => { this.setStatus({ state: 'checking' }); });
    updater.on('update-available', info => { this.setStatus({ state: 'available', version: info.version }); });
    updater.on('update-not-available', () => { this.setStatus({ state: 'idle' }); });
    updater.on('download-progress', progress => { this.setStatus({ ...this.status, state: 'downloading', percent: progress.percent }); });
    updater.on('update-downloaded', info => { this.setStatus({ state: 'downloaded', version: info.version }); });
    updater.on('error', error => { this.permitQuit(false); this.setStatus({ state: 'error', error: String(error.message ?? error) }); });
  }
  onStatus(listener: UpdateStatusListener) {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  private setStatus(status: UpdateStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(this.status);
  }
  async check() {
    if (!this.enabled) throw new Error('此安装包尚未配置正式更新源。');
    if (this.installing || ['checking', 'downloading', 'downloaded'].includes(this.status.state)) return;
    this.setStatus({ state: 'checking' });
    try { await this.updater.checkForUpdates(); }
    catch (error) { this.setStatus({ state: 'error', error: String(error) }); throw error; }
  }
  async download() {
    if (!this.enabled || this.status.state !== 'available') throw new Error('暂无可下载的更新。');
    this.setStatus({ ...this.status, state: 'downloading', percent: 0 });
    try { await this.updater.downloadUpdate(); }
    catch (error) { this.setStatus({ state: 'error', error: String(error) }); throw error; }
  }
  async install() {
    if (!this.enabled || this.status.state !== 'downloaded') throw new Error('请先下载可用更新。');
    if (this.installing) return;
    this.installing = true;
    try {
      await this.stopRuntime();
      this.permitQuit(true);
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.permitQuit(false);
      throw error;
    } finally { this.installing = false; }
  }

  async upgrade() {
    await this.check();
    if (this.status.state === 'available') await this.download();
    if (this.status.state === 'downloaded') await this.install();
    if (this.status.state !== 'downloaded' && this.status.state !== 'available') {
      throw new Error('当前更新源没有返回可安装的升级包。');
    }
  }
}
