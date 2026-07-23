import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '..', '..');
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  throw new Error('npm_execpath is unavailable; start the server through npm run dev.');
}

runBuild('@agent-cluster/shared');
runBuild('@agent-cluster/server');

await import(pathToFileURL(resolve(serverRoot, 'dist', 'apps', 'server', 'src', 'main.js')).href);

function runBuild(workspace) {
  const result = spawnSync(process.execPath, [npmExecPath, 'run', 'build', '-w', workspace], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
