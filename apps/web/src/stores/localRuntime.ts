import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPost, isAbortError } from '@/api/client'
import { createLocalRuntimeLaunchUrl, requestLocalRuntimeLaunch } from '@/utils/localRuntimeLauncher'
import type {
  LocalRuntimeCapabilityStatus,
  LocalRuntimeDevice,
  LocalRuntimeWorkspaceSummary,
  RuntimeType
} from '@agent-cluster/shared'

type LocalRuntimeDeviceView = LocalRuntimeDevice & { connected: boolean }
type LocalRuntimeWorkspaceResponse = Omit<LocalRuntimeWorkspaceSummary, 'runtimeTypes' | 'runtimeCapabilities'> & {
  runtimeTypes?: readonly RuntimeType[]
  runtimeCapabilities?: readonly LocalRuntimeCapabilityStatus[]
}

export type LocalRuntimeConnectionState = 'idle' | 'checking' | 'waking' | 'probing' | 'ready' | 'failed'

type EnsureLocalRuntimeOptions = {
  timeoutMs?: number
  pollIntervalMs?: number
  launch?: (launchUrl: string) => void
  wait?: (durationMs: number) => Promise<void>
}

/** The repository-local entry point remains available when the preview CLI is not installed globally. */
export const LOCAL_RUNTIME_MANUAL_START_COMMAND = 'npm run agent-runtime -- start'

/**
 * A wake-up that never produces a connection is far more often the browser
 * silently dropping the `agent-runtime://` launch than a missing CLI, so the copy
 * has to name both causes and give a way out that does not depend on the browser.
 */
export const LOCAL_RUNTIME_WAKE_FAILED_MESSAGE =
  (typeof window !== 'undefined' && window.agentClusterDesktop)
    ? '本地助手尚未连接，请打开“连接与更新”，检查助手状态并完成设备授权。'
    : '未检测到本地助手。浏览器可能拦截了唤醒请求：请在地址栏的弹窗中允许打开 agent-runtime 链接，'
  + `或在仓库根目录运行 ${LOCAL_RUNTIME_MANUAL_START_COMMAND} 后重新检测。若从未注册协议，请先运行页面下方的安装命令。`

const adminTokenStorageKey = 'agent-cluster.local-runtime-admin-token'
const authorizationControllers = new Map<string, AbortController>()
const authorizationPromises = new Map<string, Promise<LocalRuntimeWorkspaceSummary>>()
let connectionPromise: Promise<LocalRuntimeWorkspaceSummary[]> | undefined
let connectionAttempt = 0

export function readLocalRuntimeAdminToken() {
  return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(adminTokenStorageKey) ?? ''
}

export function saveLocalRuntimeAdminToken(token: string) {
  if (typeof sessionStorage === 'undefined') return
  const normalized = token.trim()
  if (normalized) sessionStorage.setItem(adminTokenStorageKey, normalized)
  else sessionStorage.removeItem(adminTokenStorageKey)
}

function adminRequest(token = readLocalRuntimeAdminToken()): RequestInit {
  const normalized = token.trim()
  return normalized ? { headers: { authorization: `Bearer ${normalized}` } } : {}
}

export function normalizeLocalRuntimeWorkspaces(
  workspaces: readonly LocalRuntimeWorkspaceResponse[]
): LocalRuntimeWorkspaceSummary[] {
  return workspaces.map((workspace) => ({
    ...workspace,
    runtimeTypes: [...(workspace.runtimeTypes ?? [])],
    runtimeCapabilities: [...(workspace.runtimeCapabilities ?? [])]
  }))
}

export function localRuntimeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '读取本地 Runtime 工作区失败'
  if (/POST \/local-runtime\/workspaces\/authorize failed: 500/i.test(message)) {
    return 'Local Runtime 服务刚刚重启，目录选择请求已中断。请等待几秒后重新选择目录。'
  }
  if (/administrator credential is not configured/i.test(message)) {
    return '本机 Runtime 管理尚未配置。'
  }
  if (/valid local runtime administrator credentials are required/i.test(message)) {
    return '本机 Runtime 管理员凭据无效或已过期。'
  }
  if (/LOCAL_DIRECTORY_PICKER_TIMEOUT|目录选择窗口超时|等待本机目录选择超时/i.test(message)) {
    return '等待本机目录选择超时。请确认 Local Runtime CLI 运行在当前桌面会话，系统目录选择窗口没有被挡住，然后重新选择。'
  }
  if (/正在等待目录选择|already.*directory.*select|workspace authorization.*pending/i.test(message)) {
    return '本机 Runtime 已在等待目录选择。请先处理已打开的系统目录选择窗口，或稍后重试。'
  }
  if (/Local Runtime 未连接|Local Runtime CLI is offline|Local Runtime CLI 未连接/i.test(message)) {
    return '未检测到本地助手，请重新检测或确认已安装本地桥接组件。'
  }
  if (/capabilit.*timed out|capability detection/i.test(message)) {
    return '本机 Runtime 探测超时，请重新检测。'
  }
  return message
}

export const useLocalRuntimeStore = defineStore('localRuntime', {
  state: () => ({
    workspaces: [] as LocalRuntimeWorkspaceSummary[],
    devices: [] as LocalRuntimeDeviceView[],
    loading: false,
    authorizing: false,
    activeAuthorizationRequestId: '',
    connectionState: 'idle' as LocalRuntimeConnectionState,
    connectionError: '',
    runtimeCapabilities: [] as LocalRuntimeCapabilityStatus[],
    launchServerUrl: '',
    error: ''
  }),
  getters: {
    workspaceById: (state) => (workspaceId: string) =>
      state.workspaces.find((workspace) => workspace.workspaceId === workspaceId),
    connectedDevices: (state) => state.devices.filter((device) => device.connected),
    isConnected(): boolean {
      return this.connectedDevices.length > 0
    },
    connectionBusy: (state) => ['checking', 'waking', 'probing'].includes(state.connectionState)
  },
  actions: {
    async loadWorkspaces() {
      this.loading = true
      this.error = ''
      try {
        const workspaces = await apiGet<LocalRuntimeWorkspaceResponse[]>(
          '/local-runtime/workspaces',
          adminRequest()
        )
        this.workspaces = normalizeLocalRuntimeWorkspaces(workspaces)
        this.runtimeCapabilities = [...(this.workspaces[0]?.runtimeCapabilities ?? [])]
        return this.workspaces
      } catch (error) {
        const message = localRuntimeErrorMessage(error)
        this.error = message
        throw new Error(message)
      } finally {
        this.loading = false
      }
    },
    async loadDevices() {
      this.devices = await apiGet<LocalRuntimeDeviceView[]>('/local-runtime/devices', adminRequest())
      return this.devices
    },
    /**
     * The CLI rejects launch URLs whose origin differs from the one registered by
     * `install --server`, so the server origin must always come from the backend
     * instead of the page origin. Cached so a wake-up can be fired straight from a
     * click handler without spending the browser's transient user activation on a
     * network round-trip.
     */
    async resolveLaunchServerUrl() {
      if (typeof window !== 'undefined' && window.agentClusterDesktop) {
        this.launchServerUrl = (await window.agentClusterDesktop.status()).serverUrl
        return this.launchServerUrl
      }
      if (this.launchServerUrl) return this.launchServerUrl
      const config = await apiGet<{ serverUrl: string }>('/local-runtime/launch-config')
      this.launchServerUrl = config.serverUrl
      return this.launchServerUrl
    },
    wakeLocalRuntime(launch: (launchUrl: string) => void = requestLocalRuntimeLaunch) {
      if (!this.launchServerUrl) return false
      launch(createLocalRuntimeLaunchUrl(this.launchServerUrl))
      return true
    },
    async refreshCapabilities() {
      this.connectionState = 'probing'
      const capabilities = await apiPost<LocalRuntimeCapabilityStatus[]>(
        '/local-runtime/capabilities/refresh',
        {},
        { ...adminRequest(), timeoutMs: 12_000, timeoutMessage: '本机 Runtime 探测超时，请重新检测。' }
      )
      this.runtimeCapabilities = capabilities
      await this.loadWorkspaces()
      if (!this.workspaces.length) this.runtimeCapabilities = capabilities
      return this.runtimeCapabilities
    },
    async ensureConnected(options: EnsureLocalRuntimeOptions = {}) {
      if (connectionPromise) return connectionPromise
      const attempt = ++connectionAttempt
      const wait = options.wait ?? ((durationMs) => new Promise<void>((resolve) => window.setTimeout(resolve, durationMs)))
      const pollIntervalMs = options.pollIntervalMs ?? 1_000
      const timeoutMs = options.timeoutMs ?? 15_000
      const assertActive = () => {
        if (attempt === connectionAttempt) return
        const error = new Error('Local Runtime connection check was cancelled.')
        error.name = 'AbortError'
        throw error
      }

      const operation = (async () => {
        this.connectionState = 'checking'
        this.connectionError = ''
        this.error = ''
        try {
          // Resolved together so the wake-up fires right after the device probe.
          // A second sequential round-trip here would push the protocol launch
          // outside the browser's transient user activation window.
          const [, launchServerUrl] = await Promise.all([
            this.loadDevices(),
            this.resolveLaunchServerUrl().catch(() => '')
          ])
          assertActive()
          if (!this.isConnected) {
            if (!launchServerUrl) throw new Error('无法读取本地助手唤醒地址，请稍后重新检测。')
            this.connectionState = 'waking'
            this.wakeLocalRuntime(options.launch)
            const deadline = Date.now() + timeoutMs
            while (Date.now() < deadline) {
              await wait(pollIntervalMs)
              assertActive()
              await this.loadDevices()
              if (this.isConnected) break
            }
          }
          assertActive()
          if (!this.isConnected) {
            throw new Error(LOCAL_RUNTIME_WAKE_FAILED_MESSAGE)
          }
          await this.refreshCapabilities()
          assertActive()
          this.connectionState = 'ready'
          return this.workspaces
        } catch (error) {
          if (isAbortError(error)) throw error
          const message = localRuntimeErrorMessage(error)
          this.connectionState = 'failed'
          this.connectionError = message
          this.error = message
          throw new Error(message)
        }
      })()
      connectionPromise = operation
      try {
        return await operation
      } finally {
        if (connectionPromise === operation) connectionPromise = undefined
      }
    },
    async ensureWorkspaceConnected(workspaceId: string, options: EnsureLocalRuntimeOptions = {}) {
      const normalizedWorkspaceId = workspaceId.trim()
      if (!normalizedWorkspaceId) {
        throw new Error('请先选择已连接的本地 Runtime 工作区。')
      }
      const workspaces = await this.ensureConnected(options)
      const workspace = workspaces.find((candidate) => candidate.workspaceId === normalizedWorkspaceId)
      if (!workspace) {
        throw new Error('所选本地 Runtime 工作区已断开，请重新选择本机目录。')
      }
      return workspace
    },
    cancelConnectionCheck() {
      connectionAttempt += 1
      connectionPromise = undefined
      if (this.connectionBusy) this.connectionState = 'idle'
    },
    async authorizeWorkspace() {
      const activeRequestId = this.activeAuthorizationRequestId
      const activePromise = activeRequestId ? authorizationPromises.get(activeRequestId) : undefined
      if (activePromise) return activePromise

      const requestId = crypto.randomUUID()
      const controller = new AbortController()
      this.authorizing = true
      this.activeAuthorizationRequestId = requestId
      this.error = ''
      authorizationControllers.set(requestId, controller)
      const authorization = (async () => {
        const workspaceResponse = await apiPost<LocalRuntimeWorkspaceResponse>(
          '/local-runtime/workspaces/authorize',
          { requestId },
          {
            ...adminRequest(),
            signal: controller.signal,
            timeoutMs: 130_000,
            timeoutMessage: '等待本机目录选择超时，请重新选择。'
          }
        )
        const [workspace] = normalizeLocalRuntimeWorkspaces([workspaceResponse])
        this.workspaces = normalizeLocalRuntimeWorkspaces([
          ...this.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId),
          workspace
        ])
        return this.workspaceById(workspace.workspaceId)!
      })()
      authorizationPromises.set(requestId, authorization)
      try {
        return await authorization
      } catch (error) {
        if (isAbortError(error)) throw error
        const message = localRuntimeErrorMessage(error)
        if (this.activeAuthorizationRequestId === requestId) this.error = message
        throw new Error(message)
      } finally {
        authorizationControllers.delete(requestId)
        authorizationPromises.delete(requestId)
        if (this.activeAuthorizationRequestId === requestId) {
          this.activeAuthorizationRequestId = ''
          this.authorizing = false
        }
      }
    },
    async cancelWorkspaceAuthorization(options: { keepalive?: boolean } = {}) {
      const requestId = this.activeAuthorizationRequestId
      this.activeAuthorizationRequestId = ''
      this.authorizing = false
      this.error = ''
      if (!requestId) return false
      const cancellation = apiDelete<{ requestId: string; cancelled: boolean }>(
        `/local-runtime/workspaces/authorizations/${encodeURIComponent(requestId)}`,
        { ...adminRequest(), keepalive: options.keepalive }
      )
      authorizationControllers.get(requestId)?.abort()
      try {
        return (await cancellation).cancelled
      } finally {
        authorizationControllers.delete(requestId)
        authorizationPromises.delete(requestId)
      }
    },
    async approveDevice(userCode: string, adminToken = readLocalRuntimeAdminToken()) {
      saveLocalRuntimeAdminToken(adminToken)
      const device = await apiPost<LocalRuntimeDevice>(
        '/local-runtime/device-codes/approve',
        { userCode },
        adminRequest(adminToken)
      )
      await this.loadDevices()
      return device
    }
  }
})
