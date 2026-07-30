import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { localRuntimeErrorMessage, normalizeLocalRuntimeWorkspaces, useLocalRuntimeStore } from './localRuntime'

describe('normalizeLocalRuntimeWorkspaces', () => {
  it('preserves advertised Runtime types', () => {
    const [workspace] = normalizeLocalRuntimeWorkspaces([{
      workspaceId: 'workspace-1',
      deviceId: 'device-1',
      displayName: 'project',
      connectedAt: '2026-07-24T00:00:00.000Z',
      runtimeTypes: ['codex']
    }])

    expect(workspace.runtimeTypes).toEqual(['codex'])
  })

  it('treats legacy workspace responses without Runtime types as unavailable', () => {
    const [workspace] = normalizeLocalRuntimeWorkspaces([{
      workspaceId: 'workspace-legacy',
      deviceId: 'device-legacy',
      displayName: 'legacy-project',
      connectedAt: '2026-07-23T00:00:00.000Z'
    }])

    expect(workspace.runtimeTypes).toEqual([])
  })
})

describe('localRuntimeErrorMessage', () => {
  it('turns missing administrator configuration into a user-facing Chinese state', () => {
    expect(localRuntimeErrorMessage(new Error('Local Runtime administrator credential is not configured.')))
      .toBe('本机 Runtime 管理尚未配置。')
  })

  it('keeps unrelated Runtime errors intact', () => {
    expect(localRuntimeErrorMessage(new Error('Local Runtime CLI is offline.')))
      .toBe('Local Runtime CLI 未连接，请先启动本机 Runtime。')
  })

  it('turns directory picker timeout into a recoverable action', () => {
    expect(localRuntimeErrorMessage(new Error('LOCAL_DIRECTORY_PICKER_TIMEOUT: timed out')))
      .toContain('等待本机目录选择超时')
  })

  it('turns duplicate directory authorization into a visible pending state', () => {
    expect(localRuntimeErrorMessage(new Error('本机 Runtime 正在等待目录选择，请先处理已打开的系统目录选择窗口。')))
      .toContain('已在等待目录选择')
  })
})

describe('browser-triggered Local Runtime workspace authorization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  it('stores and returns the workspace selected by the Runtime CLI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        workspaceId: 'workspace-picked',
        deviceId: 'device-local',
        displayName: 'picked-project',
        connectedAt: '2026-07-25T00:00:00.000Z',
        runtimeTypes: ['codex'],
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-picked', observedAt: '2026-07-25T00:00:00.000Z' },
        permissions: {
          workspace_read: 'allow',
          workspace_write: 'allow',
          workspace_delete: 'confirm',
          command_execute: 'allow',
          test_execute: 'allow',
          dependency_install: 'confirm'
        },
        registeredAt: '2026-07-25T00:00:00.000Z'
      },
      requestId: 'workspace-authorization-spec'
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const store = useLocalRuntimeStore()
    const workspace = await store.authorizeWorkspace()

    expect(workspace.workspaceId).toBe('workspace-picked')
    expect(store.authorizing).toBe(false)
    expect(store.workspaces).toHaveLength(1)
  })
})
