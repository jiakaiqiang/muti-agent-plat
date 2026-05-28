import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@agent-cluster/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))
    }
  }
})
