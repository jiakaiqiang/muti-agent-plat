import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: [
        'src/api/**/*.spec.ts',
        'src/components/**/*.spec.ts',
        '../desktop/renderer/components/**/*.spec.ts',
        'src/router/**/*.spec.ts',
        'src/stores/event-connection.spec.ts',
        'src/stores/event-normalization.spec.ts',
        'src/stores/localRuntime.spec.ts',
        'src/stores/runtime-stop-state.spec.ts',
        'src/stores/session-delete.spec.ts',
        'src/stores/session-file-revision.spec.ts',
        'src/stores/session-intent-routing.spec.ts',
        'src/stores/session-version-gate.spec.ts',
        'src/stores/workspaceUi.spec.ts',
        'src/stores/taskWorkspace.spec.ts',
        'src/utils/**/*.spec.ts'
      ]
    }
  })
)
