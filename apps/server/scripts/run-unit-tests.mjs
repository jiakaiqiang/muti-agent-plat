import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Node 20 的 --test 不支持 glob,默认发现规则又匹配不到 *.spec.ts,
// 这里显式收集 src 下的单测文件后交给 tsx --test 执行。
// --test-force-exit:部分 spec 会打开句柄(临时库、文件监视)且测试结束后不关闭,
// 没有该标志时进程会无限空转,npm run test 因此永远无法结束。
const serverRoot = fileURLToPath(new URL('..', import.meta.url));

function collectTestFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, files);
    } else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = collectTestFiles(join(serverRoot, 'src'));
if (!testFiles.length) {
  console.error('No *.spec.ts / *.test.ts files found under src/.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const tsxCli = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
if (!existsSync(tsxCli)) {
  console.error(`tsx CLI not found at ${tsxCli}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, '--test', '--test-force-exit', ...testFiles], {
  cwd: serverRoot,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
