import { app, BrowserWindow, ipcMain, Menu, dialog, session, net, Tray, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_URL, normalizeServer, platformKey, isAppUrl, apiTarget, assetPath, validateUpdateUrl } from './policy';
import { RuntimeManager } from './runtime-manager';
import { UpdateController } from './update-controller';
import type { DesktopStatus } from './contracts';
import { protocol } from 'electron';
import { CompletionNotifications, notificationText, type NotificationSession, type NotificationEvent } from './completion-notifications';

protocol.registerSchemesAsPrivileged([{ scheme: 'agent-cluster', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true
} }]);
// Honor Chromium's explicit profile override for isolated validation and portable test profiles.
const profileOverride = app.commandLine.getSwitchValue('user-data-dir');
if (profileOverride) app.setPath('userData', profileOverride);
const userData = app.getPath('userData');
const configFile = join(userData, 'desktop-config.json');
const workerPath = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'runtime-worker.cjs')
  : join(__dirname, 'runtime-worker.cjs');
const runtime = new RuntimeManager(workerPath);
let serverUrl = '';
let window: BrowserWindow | undefined;
let quitting = false;
let transition = false;
let updates: UpdateController;
let tray: Tray | undefined;
let devLaunchId = app.isPackaged ? '' : app.commandLine.getSwitchValue('dev-launch-id');
const notificationConfigFile = join(userData, 'notifications.json');
let notificationsEnabled = true;
let notificationError: string | undefined;
let lastNotificationShownAt: string | undefined;
let completionMonitor: CompletionNotifications | undefined;
const activeNotifications = new Set<Notification>();

function showDesktopNotification(title: string, body: string, sessionId?: string, origin = serverUrl) {
  if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知。');
  const notice = new Notification({ title, body, silent: false, timeoutType: 'default' });
  activeNotifications.add(notice);
  notice.on('show', () => { notificationError = undefined; lastNotificationShownAt = new Date().toISOString(); });
  notice.on('failed', (_event, error) => {
    notificationError = `系统通知发送失败：${error}`;
    activeNotifications.delete(notice);
  });
  notice.on('click', () => {
    if (origin !== serverUrl || quitting || transition) return;
    if (sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) return;
    if (!window || window.isDestroyed() || window.webContents.isLoading()) {
      showWindow(sessionId ? `/workspace/${encodeURIComponent(sessionId)}` : undefined);
    } else {
      showWindow();
      if (sessionId) window.webContents.send('desktop:open-session', sessionId);
    }
  });
  // Keep timed-out banners alive for later clicks from Windows notification center.
  notice.on('close', details => { if (details.reason === 'userCanceled') activeNotifications.delete(notice); });
  notice.show();
  if (activeNotifications.size > 100) {
    const oldest = activeNotifications.values().next().value;
    oldest?.close(); if (oldest) activeNotifications.delete(oldest);
  }
}

function startCompletionMonitor() {
  completionMonitor?.stop();
  for (const notice of activeNotifications) notice.close();
  activeNotifications.clear();
  if (!serverUrl) return;
  const origin = serverUrl;
  const ses = session.fromPartition(`persist:platform-${platformKey(origin)}`);
  async function items(path: string) {
    const response = await ses.fetch(new URL(path, origin).toString(), {
      credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Notification status check: HTTP ${response.status}`);
    const payload = await response.json() as { data?: { items?: unknown[] } };
    if (!Array.isArray(payload.data?.items)) throw new Error('Invalid notification status response');
    return payload.data.items;
  }
  completionMonitor = new CompletionNotifications({
    sessions: async () => await items('/api/sessions') as NotificationSession[],
    events: async (id, after) => await items(`/api/sessions/${encodeURIComponent(id)}/events${after ? `?afterEventId=${encodeURIComponent(after)}` : ''}`) as NotificationEvent[],
    enabled: () => notificationsEnabled && Notification.isSupported(),
    notify: item => {
      const text = notificationText(item.title);
      showDesktopNotification(text.title, text.body, item.sessionId, origin);
    },
    onError: error => console.warn('Completion notification check failed', error)
  });
  completionMonitor.start();
}
async function acknowledgeDevLaunch(error?: unknown) {
  if (!/^[a-f0-9-]{36}$/.test(devLaunchId)) return;
  const result = error ? { status: 'error', error: error instanceof Error ? error.message : String(error) }
    : { status: 'ready', pid: process.pid, serverUrl, visible: Boolean(window && !window.isDestroyed() && window.isVisible()) };
  const receipt = join(userData, `dev-launch-${devLaunchId}.json`);
  try {
    await mkdir(userData, { recursive: true });
    await writeFile(receipt + '.tmp', JSON.stringify(result));
    await rename(receipt + '.tmp', receipt);
  } catch (cause) { console.error('Failed to acknowledge desktop development launch', cause); }
}
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'";

async function createWindow(path = '/desktop') {
  const selectedServer = serverUrl;
  const ses = session.fromPartition(`persist:platform-${platformKey(selectedServer)}`);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (!await ses.protocol.isProtocolHandled('agent-cluster')) {
    ses.protocol.handle('agent-cluster', async (request) => {
      try {
        if (!isAppUrl(request.url)) return new Response('Forbidden', { status: 403 });
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) {
          if (!selectedServer) return Response.json({ error: { message: '请先设置平台地址。' } }, { status: 503 });
          let target: string;
          try { target = apiTarget(request.url, selectedServer, request.method); }
          catch (error) { return Response.json({ error: { message: String(error) } }, { status: 403 }); }
          const headers = new Headers(request.headers);
          for (const header of ['host', 'origin', 'referer', 'connection', 'content-length', 'cookie']) headers.delete(header);
          const response = await ses.fetch(target, {
            method: request.method, headers, credentials: 'include', redirect: 'error', signal: request.signal,
            ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {})
          });
          const returned = new Headers(response.headers);
          for (const header of ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie']) returned.delete(header);
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers: returned });
        }
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
        const resource = assetPath(join(__dirname, 'renderer'), request.url);
        const response = await net.fetch(pathToFileURL(resource).toString());
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', csp);
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return Response.json({ error: { message: '无法连接平台或读取应用资源，请检查平台地址与网络。' } }, { status: 502 });
      }
    });
  }
  const created = new BrowserWindow({
    title: 'Agent Cluster', width: 1440, height: 960, minWidth: 800, minHeight: 600,
    show: false, backgroundColor: '#f5f7fa',
    webPreferences: { session: ses, preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  });
  window = created;
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  created.webContents.on('will-attach-webview', event => event.preventDefault());
  created.on('close', event => { if (!quitting) { event.preventDefault(); created.hide(); } });
  created.once('ready-to-show', () => { created.show(); void acknowledgeDevLaunch(); });
  await created.loadURL(APP_URL + path);
  return created;
}

async function exclusive(action: () => Promise<void>) {
  if (transition || quitting) throw new Error('应用正在切换连接或退出，请稍后重试。');
  transition = true;
  try { await action(); } finally { transition = false; }
}
async function startRuntime() {
  if (transition || quitting) throw new Error('应用正在切换连接或退出。');
  if (!serverUrl) throw new Error('请先设置平台地址。');
  await runtime.start(serverUrl, join(userData, 'platforms', platformKey(serverUrl), 'runtime', 'state.json'));
}
async function quitSafely() {
  await exclusive(async () => { await runtime.stop(); quitting = true; app.quit(); });
}
function showError(error: unknown) { void dialog.showMessageBox({ type: 'warning', title: 'Agent Cluster', message: error instanceof Error ? error.message : String(error) }); }
function showWindow(path?: string) {
  if (!window || window.isDestroyed()) { void createWindow(path); return; }
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  if (path) void window.loadURL(APP_URL + path);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (!app.isPackaged) devLaunchId = argv.find(arg => arg.startsWith('--dev-launch-id='))?.slice('--dev-launch-id='.length) ?? '';
    showWindow();
    if (window && !window.webContents.isLoading()) void acknowledgeDevLaunch();
  });
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { /* Explicit application exit owns the runtime lifecycle. */ });
  app.on('before-quit', event => {
    if (!quitting) { event.preventDefault(); void quitSafely().catch(showError); }
  });
  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.agentcluster.desktop' : process.execPath);
    try { notificationsEnabled = JSON.parse(await readFile(notificationConfigFile, 'utf8')).enabled !== false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Cannot read notification settings', error); }
    try {
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      serverUrl = normalizeServer(config.serverUrl);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') showError('平台配置无法读取，请在应用连接设置中重新保存。');
    }
    const release = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8')).desktopRelease ?? {};
    const updateEnabled = app.isPackaged && Boolean(release.updateUrl && release.publisherName);
    if (release.updateUrl) validateUpdateUrl(release.updateUrl);
    // electron-builder owns app-update.yml and publisher verification; never override the feed at runtime.
    updates = new UpdateController(autoUpdater, updateEnabled, () => runtime.stop(), allowed => { quitting = allowed; });
    const status = (): DesktopStatus => ({ version: app.getVersion(), packaged: app.isPackaged, serverUrl, runtime: runtime.status, update: updates.status,
      notifications: { enabled: notificationsEnabled, supported: Notification.isSupported(), error: notificationError, lastShownAt: lastNotificationShownAt } });
    const handlers: Record<string, (...args: any[]) => unknown> = {
      'desktop:status': status,
      'desktop:configure': async (input: unknown) => {
        if (typeof input !== 'string' || input.length > 2048) throw new Error('请输入有效的平台地址。');
        const next = normalizeServer(input.trim());
        await exclusive(async () => {
          const health = await net.fetch(new URL('/api/health', next).toString(), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
          if (!health.ok) throw new Error(`平台健康检查失败（${health.status}）。`);
          const payload = await health.json();
          if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new Error('该地址未返回 Agent Cluster 平台响应。');
          await runtime.stop();
          await mkdir(userData, { recursive: true });
          const temporary = configFile + '.tmp';
          await writeFile(temporary, JSON.stringify({ schemaVersion: 1, serverUrl: next }) + '\n', { mode: 0o600 });
          await rename(temporary, configFile);
          const previous = window;
          serverUrl = next;
          startCompletionMonitor();
          await createWindow('/desktop');
          previous?.destroy();
        });
      },
      'desktop:runtime:start': startRuntime,
      'desktop:notifications:enabled': (enabled: unknown) => exclusive(async () => {
        if (typeof enabled !== 'boolean') throw new Error('通知设置必须为开或关。');
        await mkdir(userData, { recursive: true });
        await writeFile(notificationConfigFile + '.tmp', JSON.stringify({ enabled }) + '\n');
        await rename(notificationConfigFile + '.tmp', notificationConfigFile);
        notificationsEnabled = enabled;
      }),
      'desktop:notifications:test': () => {
        if (!notificationsEnabled) throw new Error('请先开启任务完成通知。');
        showDesktopNotification('任务通知测试', '通知已开启。会话任务完成后，将在这里提醒你。');
      },
      'desktop:web:workflow-manager': async () => {
        if (!serverUrl) throw new Error('请先连接 Web 平台。');
        await shell.openExternal(new URL('/workflows', serverUrl).toString());
      },
      'desktop:runtime:stop': () => exclusive(() => runtime.stop()),
      'desktop:update:check': () => updates.check(),
      'desktop:update:download': () => updates.download(),
      'desktop:update:install': () => exclusive(() => updates.install())
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
          throw new Error('Untrusted desktop IPC sender');
        }
        return handler(...args);
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '应用', submenu: [
        { label: '显示工作台', click: () => showWindow('/workspace') },
        { label: '连接与更新', click: () => showWindow('/desktop') },
        { label: '启动本地助手', click: () => { void startRuntime().catch(showError); } },
        { type: 'separator' },
        { label: '退出应用', accelerator: 'CommandOrControl+Q', click: () => { void quitSafely().catch(showError); } }
      ] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : [])] }
    ]));
    tray = new Tray(await app.getFileIcon(process.execPath));
    tray.setToolTip('Agent Cluster');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示工作台', click: () => showWindow() },
      { label: '连接与更新', click: () => showWindow('/desktop') },
      { label: '退出应用', click: () => { void quitSafely().catch(showError); } }
    ]));
    tray.on('double-click', () => showWindow());
    await createWindow(serverUrl ? '/workspace' : '/desktop');
    startCompletionMonitor();
    app.once('will-quit', () => { completionMonitor?.stop(); });
  }).catch(async error => { await acknowledgeDevLaunch(error); showError(error); quitting = true; app.quit(); });
}
