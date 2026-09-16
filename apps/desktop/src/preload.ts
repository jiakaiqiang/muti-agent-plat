import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contracts';

const bridge: DesktopBridge = {
  status: () => ipcRenderer.invoke('desktop:status'),
  configure: (serverUrl) => ipcRenderer.invoke('desktop:configure', serverUrl),
  startRuntime: () => ipcRenderer.invoke('desktop:runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('desktop:runtime:stop'),
  checkUpdate: () => ipcRenderer.invoke('desktop:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update:download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update:install'),
  setNotificationsEnabled: enabled => ipcRenderer.invoke('desktop:notifications:enabled', enabled),
  testNotification: () => ipcRenderer.invoke('desktop:notifications:test'),
  onOpenSession: callback => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) callback(sessionId);
    };
    ipcRenderer.on('desktop:open-session', listener);
    return () => ipcRenderer.removeListener('desktop:open-session', listener);
  }
};
contextBridge.exposeInMainWorld('agentClusterDesktop', Object.freeze(bridge));
