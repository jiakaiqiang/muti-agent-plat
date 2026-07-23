import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const tsxCli = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
const entrypoint = resolve('apps/server/src/modules/persistence/cutover-context-v2.cli.ts');
const result = spawnSync(process.execPath, [tsxCli, entrypoint, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
