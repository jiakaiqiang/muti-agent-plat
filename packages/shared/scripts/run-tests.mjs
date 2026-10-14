import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const sourceRoot = join(packageRoot, 'src');
function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(path);
    return /\.(spec|test)\.ts$/.test(entry.name) ? [path] : [];
  });
}

const tests = collectTests(sourceRoot).sort();

if (!tests.length) throw new Error('No shared contract tests found.');
const tsx = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// --test-force-exit: spec 打开的句柄在测试结束后不关闭,没有该标志时进程空转,
// npm run test 因此无法结束。
const result = spawnSync(process.execPath, [tsx, '--test', '--test-force-exit', ...tests], {
  cwd: repositoryRoot,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
