import type { UpdateStatus } from './contracts';

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
  constructor(private updater: Updater, private enabled: boolean, private stopRuntime: () => Promise<void>, private permitQuit: (allowed: boolean) => void) {
    this.status = { state: enabled ? 'idle' : 'unconfigured' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => { this.status = { state: 'checking' }; });
    updater.on('update-available', info => { this.status = { state: 'available', version: info.version }; });
    updater.on('update-not-available', () => { this.status = { state: 'idle' }; });
    updater.on('download-progress', progress => { this.status = { ...this.status, state: 'downloading', percent: progress.percent }; });
    updater.on('update-downloaded', info => { this.status = { state: 'downloaded', version: info.version }; });
    updater.on('error', error => { this.permitQuit(false); this.status = { state: 'error', error: String(error.message ?? error) }; });
  }
  async check() {
    if (!this.enabled) throw new Error('此安装包尚未配置正式更新源。');
    if (this.installing || ['checking', 'downloading', 'downloaded'].includes(this.status.state)) return;
    this.status = { state: 'checking' };
    try { await this.updater.checkForUpdates(); }
    catch (error) { this.status = { state: 'error', error: String(error) }; throw error; }
  }
  async download() {
    if (!this.enabled || this.status.state !== 'available') throw new Error('暂无可下载的更新。');
    this.status = { ...this.status, state: 'downloading', percent: 0 };
    try { await this.updater.downloadUpdate(); }
    catch (error) { this.status = { state: 'error', error: String(error) }; throw error; }
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
}
