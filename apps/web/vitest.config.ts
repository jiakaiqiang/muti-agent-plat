import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: [
        'src/components/**/*.spec.ts',
        'src/router/**/*.spec.ts',
        'src/stores/event-connection.spec.ts',
        'src/stores/event-normalization.spec.ts',
        'src/stores/session-version-gate.spec.ts',
        'src/stores/workspaceBrokerReconnect.spec.ts',
        'src/stores/workspaceUi.spec.ts'
      ]
    }
  })
)
