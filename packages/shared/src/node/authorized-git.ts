import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class AuthorizedGit {
  async run(cwd: string, args: readonly string[], token?: string, options?: { raw?: boolean }): Promise<string> {
    const bytes = await this.runBytes(cwd, args, token);
    const output = bytes.toString('utf8');
    return options?.raw ? output : output.trim();
  }

  async runBytes(cwd: string, args: readonly string[], token?: string): Promise<Buffer> {
    const askPass = token ? join(tmpdir(), `agent-cluster-askpass-${randomUUID()}${process.platform === 'win32' ? '.cmd' : '.sh'}`) : undefined;
    if (askPass) {
      const script = process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.env.AGENT_CLUSTER_GIT_TOKEN || '')"\r\n`
        : '#!/bin/sh\nprintf "%s\\n" "$AGENT_CLUSTER_GIT_TOKEN"\n';
      await writeFile(askPass, script, { flag: 'wx', mode: 0o700 });
    }
    try {
      return await this.spawnGit(cwd, args, token, askPass);
    } finally {
      if (askPass) await unlink(askPass).catch(() => undefined);
    }
  }

  private spawnGit(cwd: string, args: readonly string[], token?: string, askPass?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [
        '-c', 'credential.helper=', '-c', 'credential.username=x-access-token',
        '-c', 'http.followRedirects=false', '-c', 'protocol.ext.allow=never',
        '-C', cwd, ...args
      ], {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
          ...(askPass ? { GIT_ASKPASS: askPass, AGENT_CLUSTER_GIT_TOKEN: token } : {})
        }
      });
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(code));
      };
      const timer = setTimeout(() => fail('GITHUB_GIT_TIMEOUT'), 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) return fail('GITHUB_GIT_OUTPUT_LIMIT');
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) fail('GITHUB_GIT_OUTPUT_LIMIT');
      });
      child.on('error', () => fail('GITHUB_GIT_UNAVAILABLE'));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new Error('GITHUB_GIT_COMMAND_FAILED', { cause: args[0] }));
        else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
  }
}
