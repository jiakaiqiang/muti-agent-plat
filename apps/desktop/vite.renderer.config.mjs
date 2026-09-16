import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const desktop = fileURLToPath(new URL('.', import.meta.url));
const web = resolve(desktop, '../web');
const webRequire = createRequire(resolve(web, 'package.json'));
const vue = webRequire('@vitejs/plugin-vue');
// Resolve one Pinia instance for both shared domain stores and desktop components.
export default {
  root: resolve(desktop, 'renderer'),
  envDir: resolve(desktop, '../..'),
  plugins: [vue()],
  preview: {
    proxy: { '/api': { target: process.env.AGENT_CLUSTER_DEV_API_PROXY_TARGET || 'http://127.0.0.1:8099', changeOrigin: true } }
  },
  resolve: {
    dedupe: ['vue', 'pinia', 'vue-router'],
    alias: {
      '@': resolve(web, 'src'),
      '@agent-cluster/shared': resolve(desktop, '../../packages/shared/src/index.ts'),
      pinia: webRequire.resolve('pinia')
    }
  }
};
