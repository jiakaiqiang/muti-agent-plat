import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const devApiProxyTarget = process.env.AGENT_CLUSTER_DEV_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8099'

export default defineConfig({
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  server: {
    port: 8089,
    strictPort: true,
    proxy: {
      '/api': {
        target: devApiProxyTarget,
        changeOrigin: true
      },
      '/local-runtime': {
        target: devApiProxyTarget,
        changeOrigin: true,
        ws: true,
        bypass(request) {
          return request.headers.upgrade?.toLowerCase() === 'websocket' ? undefined : request.url
        }
      }
    }
  },
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@agent-cluster/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))
    }
  }
})
