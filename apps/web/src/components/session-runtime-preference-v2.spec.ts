import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const store = readFileSync(resolve('src/stores/session.ts'), 'utf8')
const component = readFileSync(resolve('src/components/SessionWorkspace.vue'), 'utf8')

describe('Session Runtime preference v2 boundary', () => {
  it('Session create input exposes optional runtimePreference', () => {
    expect(store).toMatch(/runtimePreference\??:\s*RuntimePreference/)
  })

  it('Session store removes engineeringRuntimeType', () => {
    expect(store).not.toMatch(/engineeringRuntimeType/)
  })

  it('Session store removes EngineeringRuntimeConfig', () => {
    expect(store).not.toMatch(/EngineeringRuntimeConfig|engineeringRuntime\??:/)
  })

  it('Session store never accepts a fixed executionTarget', () => {
    expect(store).not.toMatch(/ExecutionTarget|executionTarget\??:/)
  })

  it('Session UI does not read contextPipelineVersion', () => {
    expect(component).not.toMatch(/contextPipelineVersion|currentContextPipelineVersion/)
  })

  it('Session UI does not construct a resolved execution target', () => {
    expect(component).not.toMatch(/const executionTarget|executionTarget\s*:/)
  })

  it('Session UI sends a Runtime preference rather than a fixed Runtime field', () => {
    expect(component).toMatch(/runtimePreference/)
    expect(component).toMatch(/allowedRuntimeTypes/)
    expect(component).toMatch(/sessionFallbackRuntimeTypes/)
    expect(component).toMatch(/不会使用未授权的 Runtime/)
    expect(component).not.toMatch(/engineeringRuntimeType/)
  })

  it('Session UI keeps browser-local and server-local workspace choices available for Codex/Claude', () => {
    expect(component).toMatch(/sessionWorkspaceKind/)
    expect(component).toMatch(/sessionServerWorkspacePath/)
    expect(component).toMatch(/isRuntimeAvailable/)
    expect(component).toMatch(/浏览器目录通过隔离镜像执行/)
    expect(component).not.toMatch(/sessionWorkspaceKind\.value\s*=\s*['"]server_local['"]/)
    expect(component).not.toMatch(/:disabled="sessionRuntimeType === 'codex'/)
    expect(component).not.toMatch(/Runtime 需要服务器本地工作区/)
    expect(component).toMatch(/supportedWorkspaceProviderKinds\.includes\(selectedWorkspaceProviderKind\.value\)/)
  })

  it('Session UI clears stale directory errors when Runtime or workspace mode changes', () => {
    expect(component).toMatch(/function handleRuntimePreferenceChange\(\)[\s\S]*?sessionCreateError\.value = ''/)
    expect(component).toMatch(/function selectSessionWorkspaceKind[\s\S]*?sessionCreateError\.value = ''/)
    expect(component).toMatch(/请输入服务器本地工作目录/)
    expect(component).toMatch(/function closeCreateSessionDialog[\s\S]*?clearPendingDirectory\(\)/)
  })

  it('Session UI describes Runtime and model choices as preferences', () => {
    expect(component).toMatch(/Runtime 偏好/)
    expect(component).not.toMatch(/创建时固化|统一 Runtime|固定 Runtime/)
  })
})
