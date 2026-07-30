import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = resolve(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const serverUrl = option(process.argv.slice(2), '--server') ?? 'http://127.0.0.1:8099';

await waitForBackend(new URL('/api/health', serverUrl));

const child = spawn(process.execPath, [tsxCli, 'src/cli.ts', 'start', '--server', serverUrl], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});

const stop = (signal) => {
  if (child.exitCode === null) child.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

async function waitForBackend(healthUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // The supervisor starts server, web and Runtime concurrently.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Local Runtime backend did not become ready: ${healthUrl}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
