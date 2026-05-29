import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

function parseEnvLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex < 0) {
    return undefined;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (!key) {
    return undefined;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function findUp(fileName: string, startDir: string) {
  let currentDir = resolve(startDir);
  while (true) {
    const candidate = join(currentDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

export function loadLocalEnv() {
  const configuredPath = process.env.AGENT_CLUSTER_ENV_FILE;
  const envPath = configuredPath ? resolve(configuredPath) : findUp('.env', process.cwd());
  if (!envPath || !existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry && process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
    }
  }

  process.env.AGENT_CLUSTER_ENV_FILE = process.env.AGENT_CLUSTER_ENV_FILE ?? envPath;
  process.env.AGENT_CLUSTER_ENV_DIR = process.env.AGENT_CLUSTER_ENV_DIR ?? parse(envPath).dir;
}
