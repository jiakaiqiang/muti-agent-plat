import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('apps/web/package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const server = await createServer({ configFile: false, envFile: false,
  root: resolve('tests/evaluation/intent-correction-ui'), plugins: [vue()],
  resolve: { alias: { '@': resolve('apps/web/src'), '@agent-cluster/shared': resolve('packages/shared/src/index.ts') } },
  server: { host: '127.0.0.1', port: 4187, strictPort: true, fs: { allow: [process.cwd()] } }
});
await server.listen();
console.log('Correction UI fixture: http://127.0.0.1:4187');
