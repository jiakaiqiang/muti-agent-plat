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
      runtimeTypes: ['codex'],
      runtimeCapabilities: [{
        runtimeType: 'codex',
        status: 'ready',
        version: 'codex 1.0',
        checkedAt: '2026-08-06T00:00:00.000Z'
      }]
    }])

    expect(workspace.runtimeTypes).toEqual(['codex'])
    expect(workspace.runtimeCapabilities[0]?.status).toBe('ready')
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

  it('turns an offline helper into the recoverable wake-up message', () => {
    expect(localRuntimeErrorMessage(new Error('Local Runtime CLI is offline.')))
      .toBe('未检测到本地助手，请重新检测或确认已安装本地桥接组件。')
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

it('identifies a Vite proxy reset during directory authorization as a retryable restart', () => {
  expect(localRuntimeErrorMessage(new Error('POST /local-runtime/workspaces/authorize failed: 500')))
    .toContain('服务刚刚重启')
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

  it('wakes an offline helper once, waits for connection, then refreshes CLI capabilities', async () => {
    let deviceReads = 0
    const launch = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/local-runtime/devices')) {
        deviceReads += 1
        return jsonResponse(deviceReads === 1 ? [] : [{
          deviceId: 'device-local',
          ownerId: 'local-user',
          displayName: 'developer-pc',
          cliVersion: '0.1.0',
          protocolVersion: 7,
          runtimes: {},
          createdAt: '2026-08-06T00:00:00.000Z',
          lastSeenAt: '2026-08-06T00:00:00.000Z',
          connected: true
        }])
      }
      if (url.endsWith('/local-runtime/launch-config')) {
        return jsonResponse({ serverUrl: 'http://127.0.0.1:8089' })
      }
      if (url.endsWith('/local-runtime/capabilities/refresh') && init?.method === 'POST') {
        return jsonResponse([{
          runtimeType: 'codex', status: 'ready', version: 'codex 1.0', checkedAt: '2026-08-06T00:00:00.000Z'
        }])
      }
      if (url.endsWith('/local-runtime/workspaces')) {
        return jsonResponse([])
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }))

    const store = useLocalRuntimeStore()
    await store.ensureConnected({
      launch,
      pollIntervalMs: 1,
      timeoutMs: 100,
      wait: async () => undefined
    })

    expect(launch).toHaveBeenCalledOnce()
    expect(launch.mock.calls[0]?.[0]).toContain('agent-runtime://connect')
    expect(launch.mock.calls[0]?.[0]).toContain(encodeURIComponent('http://127.0.0.1:8089'))
    expect(store.connectionState).toBe('ready')
    expect(store.runtimeCapabilities[0]?.runtimeType).toBe('codex')
  })

  it('deduplicates repeated clicks while one directory picker is active', async () => {
    let resolveFetch!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))
    vi.stubGlobal('fetch', fetch)

    const store = useLocalRuntimeStore()
    const first = store.authorizeWorkspace()
    const second = store.authorizeWorkspace()

    expect(fetch).toHaveBeenCalledTimes(1)
    resolveFetch(new Response(JSON.stringify({
      data: {
        workspaceId: 'workspace-deduplicated',
        deviceId: 'device-local',
        displayName: 'picked-project',
        connectedAt: '2026-07-25T00:00:00.000Z',
        runtimeTypes: ['codex']
      },
      requestId: 'workspace-authorization-spec'
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const [firstWorkspace, secondWorkspace] = await Promise.all([first, second])
    expect(firstWorkspace.workspaceId).toBe('workspace-deduplicated')
    expect(secondWorkspace.workspaceId).toBe('workspace-deduplicated')
  })

  it('cancels the active picker by request ID when the create-session dialog closes', async () => {
    const requests: Array<{ url: string; method: string; body?: string; keepalive?: boolean }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        keepalive: init?.keepalive
      })
      if (method === 'DELETE') {
        return new Response(JSON.stringify({
          data: { requestId: url.split('/').at(-1), cancelled: true },
          requestId: 'cancel-spec'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }))

    const store = useLocalRuntimeStore()
    const authorization = store.authorizeWorkspace()
    const cancelled = await store.cancelWorkspaceAuthorization({ keepalive: true })

    expect(cancelled).toBe(true)
    await expect(authorization).rejects.toMatchObject({ name: 'AbortError' })
    const authorizeBody = JSON.parse(requests.find((request) => request.method === 'POST')?.body ?? '{}')
    const cancelUrl = requests.find((request) => request.method === 'DELETE')?.url ?? ''
    expect(cancelUrl.endsWith(`/local-runtime/workspaces/authorizations/${authorizeBody.requestId}`)).toBe(true)
    expect(requests.find((request) => request.method === 'DELETE')?.keepalive).toBe(true)
    expect(store.authorizing).toBe(false)
    expect(store.error).toBe('')
  })

  it('restores directory authorization state even when no request is active', async () => {
    const store = useLocalRuntimeStore()
    store.authorizing = true
    store.error = 'old error'

    expect(await store.cancelWorkspaceAuthorization()).toBe(false)
    expect(store.activeAuthorizationRequestId).toBe('')
    expect(store.authorizing).toBe(false)
    expect(store.error).toBe('')
  })
})

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'local-runtime-store-spec' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
