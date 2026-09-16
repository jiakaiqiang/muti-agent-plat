import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeStatus } from './contracts';

export class RuntimeManager {
  status: RuntimeStatus = { state: 'stopped', busy: 0 };
  private child?: UtilityProcess;
  private stopping?: Promise<void>;
  private starting?: Promise<void>;
  constructor(private entry: string) {}
  async start(server: string, stateFile: string) {
    if (this.stopping) throw new Error('助手正在停止，请稍后重试。');
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      this.status = { state: 'starting', busy: 1 };
      const env: NodeJS.ProcessEnv = { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile };
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      const child = utilityProcess.fork(this.entry, [server], {
        cwd: dirname(stateFile), env, stdio: 'ignore', serviceName: 'Agent Cluster Local Runtime'
      });
      this.child = child;
      child.on('message', (message) => {
        if (message?.kind === 'status') this.status = message.status;
      });
      child.once('exit', (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.status = code === 0 ? { state: 'stopped', busy: 0 }
          : { state: 'error', busy: 0, error: this.status.error || `本地助手异常退出（${code}），请检查连接后重新启动。` };
      });
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  async stop() {
    if (this.starting) await this.starting;
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopping = new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); };
      const onExit = (code: number) => { cleanup(); code === 0 ? resolve() : reject(new Error('助手异常退出，未执行更新或平台切换。')); };
      const onMessage = (message: { kind?: string; id?: string; error?: string }) => {
        if (message.kind === 'stop-rejected' && message.id === id) { cleanup(); reject(new Error(message.error)); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('未收到助手安全退出确认，操作已取消；不会强制结束进程。')); }, 15_000);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.postMessage({ kind: 'stop', id });
    });
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
}
