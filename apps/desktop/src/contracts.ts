export type RuntimeStatus = {
  state: 'stopped' | 'starting' | 'authorizing' | 'connecting' | 'connected' | 'error';
  busy: number;
  userCode?: string;
  error?: string;
};
export type UpdateStatus = {
  state: 'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  error?: string;
};
export type DesktopStatus = {
  version: string;
  packaged: boolean;
  serverUrl: string;
  runtime: RuntimeStatus;
  update: UpdateStatus;
  notifications: { enabled: boolean; supported: boolean; error?: string; lastShownAt?: string };
};
export interface DesktopBridge {
  status(): Promise<DesktopStatus>;
  configure(serverUrl: string): Promise<void>;
  startRuntime(): Promise<void>;
  stopRuntime(): Promise<void>;
  checkUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  setNotificationsEnabled(enabled: boolean): Promise<void>;
  testNotification(): Promise<void>;
  onOpenSession(callback: (sessionId: string) => void): () => void;
}
