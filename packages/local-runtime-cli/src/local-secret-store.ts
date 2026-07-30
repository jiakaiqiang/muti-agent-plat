import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { stateFilePath } from './state.js';

type SecretFile = { version: 1; values: Record<string, string> };

export class LocalSecretStore {
  private readonly path: string;

  constructor(path = join(dirname(stateFilePath()), 'provider-secrets.json')) {
    this.path = path;
  }

  async set(id: string, value: string) {
    const secrets = await this.read();
    secrets.values[id] = await protect(value);
    await this.write(secrets);
  }

  async get(id: string) {
    const encrypted = (await this.read()).values[id];
    return encrypted ? unprotect(encrypted) : undefined;
  }

  async delete(id: string) {
    const secrets = await this.read();
    if (!(id in secrets.values)) return;
    delete secrets.values[id];
    await this.write(secrets);
  }

  private async read(): Promise<SecretFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as SecretFile;
      if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object') {
        throw new Error('Unsupported Local Runtime secret store schema.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, values: {} };
      throw error;
    }
  }

  private async write(secrets: SecretFile) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path);
  }
}

async function protect(value: string) {
  return runDpapi(
    "$input = [Console]::In.ReadToEnd(); $bytes = [Text.Encoding]::UTF8.GetBytes($input); $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($encrypted)",
    value
  );
}

async function unprotect(value: string) {
  return runDpapi(
    "$input = [Console]::In.ReadToEnd(); $encrypted = [Convert]::FromBase64String($input); $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)",
    value
  );
}

function runDpapi(script: string, input: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Local API credential storage is currently supported only on Windows.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Windows credential protection failed (exit ${code ?? 'null'}): ${stderr.trim().slice(-500)}`));
    });
    child.stdin.end(input, 'utf8');
  });
}
