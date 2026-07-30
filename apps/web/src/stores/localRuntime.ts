import { defineStore } from 'pinia'
import { apiGet, apiPost } from '@/api/client'
import type {
  LocalRuntimeDevice,
  LocalRuntimeWorkspaceSummary,
  RuntimeType
} from '@agent-cluster/shared'

type LocalRuntimeDeviceView = LocalRuntimeDevice & { connected: boolean }
type LocalRuntimeWorkspaceResponse = Omit<LocalRuntimeWorkspaceSummary, 'runtimeTypes'> & {
  runtimeTypes?: readonly RuntimeType[]
}

const adminTokenStorageKey = 'agent-cluster.local-runtime-admin-token'

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
    runtimeTypes: [...(workspace.runtimeTypes ?? [])]
  }))
}

export function localRuntimeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '读取本地 Runtime 工作区失败'
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
    return 'Local Runtime CLI 未连接，请先启动本机 Runtime。'
  }
  return message
}

export const useLocalRuntimeStore = defineStore('localRuntime', {
  state: () => ({
    workspaces: [] as LocalRuntimeWorkspaceSummary[],
    devices: [] as LocalRuntimeDeviceView[],
    loading: false,
    authorizing: false,
    error: ''
  }),
  getters: {
    workspaceById: (state) => (workspaceId: string) =>
      state.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
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
    async authorizeWorkspace() {
      this.authorizing = true
      this.error = ''
      try {
        const workspace = await apiPost<LocalRuntimeWorkspaceResponse>(
          '/local-runtime/workspaces/authorize',
          {},
          {
            ...adminRequest(),
            timeoutMs: 130_000,
            timeoutMessage: '等待本机目录选择超时，请重新选择。'
          }
        )
        this.workspaces = normalizeLocalRuntimeWorkspaces([
          ...this.workspaces.filter((item) => item.workspaceId !== workspace.workspaceId),
          workspace
        ])
        return this.workspaceById(workspace.workspaceId)!
      } catch (error) {
        const message = localRuntimeErrorMessage(error)
        this.error = message
        throw new Error(message)
      } finally {
        this.authorizing = false
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
