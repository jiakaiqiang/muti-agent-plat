import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(desktop, '../..');
const web = resolve(root, 'apps/web');
const { version: appVersion } = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'));
const { version: runtimeVersion } = JSON.parse(await readFile(resolve(root, 'packages/local-runtime-cli/package.json'), 'utf8'));
const webRequire = createRequire(resolve(web, 'package.json'));
const check = spawnSync(process.execPath, [webRequire.resolve('vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', resolve(desktop, 'renderer/tsconfig.json')], { cwd: web, stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
const vue = spawnSync(process.execPath, [resolve(webRequire.resolve('vite/package.json'), '../bin/vite.js'), 'build', '--config', resolve(desktop, 'vite.renderer.config.mjs'), '--outDir', resolve(desktop, 'dist/renderer'), '--emptyOutDir'], {
  cwd: web, stdio: 'inherit',
  env: { ...process.env, VITE_DESKTOP: 'true', VITE_APP_VERSION: appVersion, VITE_ENABLE_MOCKS: 'false', VITE_API_BASE_URL: '/api', VITE_SSE_BASE_URL: '/api' }
});
if (vue.status !== 0) process.exit(vue.status ?? 1);
await build({
  entryPoints: ['main', 'preload', 'runtime-worker'].map(name => resolve(desktop, `src/${name}.ts`)),
  outdir: resolve(desktop, 'dist'), outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', 'electron-updater'],
  alias: { '@agent-cluster/shared': resolve(root, 'packages/shared/src/index.ts') },
  define: { '__LOCAL_RUNTIME_VERSION__': JSON.stringify(runtimeVersion) }
});
const updateUrl = process.env.AGENT_CLUSTER_UPDATE_URL?.trim() || '';
if (updateUrl) {
  const url = new URL(updateUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid HTTPS update URL');
}
await mkdir(resolve(desktop, 'dist'), { recursive: true });
await writeFile(resolve(desktop, 'dist/release.json'), JSON.stringify({ updateUrl }) + '\n');
