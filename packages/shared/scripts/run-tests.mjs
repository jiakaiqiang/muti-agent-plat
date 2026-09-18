import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const sourceRoot = join(packageRoot, 'src');
const tests = readdirSync(sourceRoot)
  .filter((name) => /\.(spec|test)\.ts$/.test(name))
  .sort()
  .map((name) => join(sourceRoot, name));

if (!tests.length) throw new Error('No shared contract tests found.');
const tsx = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// --test-force-exit: spec 打开的句柄在测试结束后不关闭,没有该标志时进程空转,
// npm run test 因此无法结束。
const result = spawnSync(process.execPath, [tsx, '--test', '--test-force-exit', ...tests], {
  cwd: repositoryRoot,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
