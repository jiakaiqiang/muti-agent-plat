import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { router } from './index'

const appShellSource = readFileSync(resolve('src/components/AppShell.vue'), 'utf8')

describe('application routes', () => {
  it('registers every top-level navigation destination as a real route', () => {
    const paths = new Set(router.getRoutes().map((route) => route.path))
    const expectedPaths = [
      '/workspace',
      '/workspace/:sessionId',
      '/local-runtime',
      '/local-runtime/activate',
      '/workflows',
      '/agents',
      '/skills',
      '/knowledge',
      '/settings',
      '/models',
      '/tools',
      '/notifications'
    ]

    expectedPaths.forEach((path) => expect(paths.has(path), `missing route: ${path}`).toBe(true))
  })

  it('isolates shared route components by full path and renders a failure fallback', () => {
    expect(appShellSource).toContain(':key="viewRoute.fullPath"')
    expect(appShellSource).toContain('onErrorCaptured')
    expect(appShellSource).toContain('页面加载失败')
    expect(appShellSource).toContain('重新加载页面')
  })
})
