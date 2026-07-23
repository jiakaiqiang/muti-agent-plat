import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';

export function applyEnvFile(envPath, env = process.env) {
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function positivePort(value, fallback = 8099) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function acquireDevServerLock({ lockPath, pid = process.pid, processAlive = isProcessAlive }) {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
      closeSync(fd);
      fd = undefined;
      return {
        release() {
          const owner = readLockOwner(lockPath);
          if (owner?.pid === pid) rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const owner = readLockOwner(lockPath);
      if (owner?.pid && processAlive(owner.pid)) {
        const conflict = new Error(`Development server is already running (pid ${owner.pid}).`);
        conflict.code = 'DEV_SERVER_ALREADY_RUNNING';
        conflict.ownerPid = owner.pid;
        throw conflict;
      }
      rmSync(lockPath, { force: true });
    }
  }

  throw new Error(`Unable to acquire development server lock: ${lockPath}`);
}

export function isPortListening(port, host = '127.0.0.1', timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}
