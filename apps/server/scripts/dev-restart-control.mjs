import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

export function devServerRestartRequestPath(workspaceRoot, port) {
  return join(workspaceRoot, '.cache', 'agent-cluster', `dev-server-${port}.restart.json`);
}

export function writeDevServerRestartRequest(requestPath, request) {
  mkdirSync(dirname(requestPath), { recursive: true });
  if (existsSync(requestPath)) {
    const error = new Error('A backend restart request is already pending.');
    error.code = 'DEV_SERVER_RESTART_PENDING';
    throw error;
  }

  const temporaryPath = `${requestPath}.${process.pid}.${request.requestId}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, ...request })}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    renameSync(temporaryPath, requestPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function consumeDevServerRestartRequest(requestPath) {
  if (!existsSync(requestPath)) return undefined;
  const contents = readFileSync(requestPath, 'utf8');
  rmSync(requestPath, { force: true });
  const request = JSON.parse(contents);
  if (
    request?.version !== 1 ||
    typeof request.requestId !== 'string' ||
    typeof request.requestedAt !== 'string' ||
    !Number.isInteger(request.launcherPid)
  ) {
    throw new Error(`Invalid backend restart request: ${requestPath}`);
  }
  return request;
}

export function discardDevServerRestartRequest(requestPath) {
  rmSync(requestPath, { force: true });
}
