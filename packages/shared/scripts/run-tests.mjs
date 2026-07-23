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
const result = spawnSync(process.execPath, [tsx, '--test', ...tests], {
  cwd: repositoryRoot,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
