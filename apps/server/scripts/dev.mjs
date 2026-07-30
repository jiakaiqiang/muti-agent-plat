import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shouldBuildDevServer, writeDevBuildStamp } from './dev-build-cache.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '..', '..');
const npmExecPath = process.env.npm_execpath;
const sourceRoots = [resolve(serverRoot, 'src'), resolve(workspaceRoot, 'packages', 'shared', 'src')];
const outputPath = resolve(serverRoot, 'dist', 'apps', 'server', 'src', 'main.js');
const stampPath = resolve(workspaceRoot, '.cache', 'agent-cluster', 'dev-build-input.json');

if (!npmExecPath) {
  throw new Error('npm_execpath is unavailable; start the server through npm run dev.');
}

const buildDecision = shouldBuildDevServer({ roots: sourceRoots, stampPath, outputPath });
if (buildDecision.build) {
  console.log(`[dev-server] building because ${buildDecision.reason}`);
  runBuild('@agent-cluster/shared');
  runBuild('@agent-cluster/server');
  writeDevBuildStamp(stampPath, buildDecision.fingerprint);
} else {
  console.log('[dev-server] source unchanged; reusing the current build output');
}

await import(pathToFileURL(outputPath).href);

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
