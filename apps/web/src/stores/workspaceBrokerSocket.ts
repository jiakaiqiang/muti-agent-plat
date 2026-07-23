import type {
  SearchTextMatch,
  WorkspaceOperationRequest,
  WorkspaceOperationResult,
  WorkspaceRevision,
  WorkspaceConflictError
} from '@agent-cluster/shared'
import { WORKSPACE_BASE_HASH_MISMATCH } from '@agent-cluster/shared'
import { apiBaseUrl } from '@/config/runtime'
import { browserApplyChangeSet } from './workspaceBrokerApplyChangeSet'
import { browserListDirectory } from './workspaceBrokerListDirectory'
import { browserReadFile } from './workspaceBrokerReadFile'
import { browserStatFile, BrowserWorkspaceFileNotFoundError } from './workspaceBrokerStatFile'
import { assertSafeBrowserWorkspacePath, isSensitiveBrowserWorkspacePath } from './workspaceBrokerPath'
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared'
import { runBrowserWorkspaceWrite } from './workspaceWriteCoordinator'
import { workspaceBrokerReconnectDelay } from './workspaceBrokerReconnect'

type RegisteredWorkspace = {
  workspaceId: string
  displayName: string
  handle: FileSystemDirectoryHandle
  revision: WorkspaceRevision
}

export class WorkspaceBrokerSocket {
  private socket?: WebSocket
  private connectPromise?: Promise<void>
  private readonly workspaces = new Map<string, RegisteredWorkspace>()
  private readonly registrationWaiters = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
    timer: number
  }>()
  private heartbeatTimer?: number
  private reconnectTimer?: number
  private reconnectAttempts = 0
  readonly clientId = crypto.randomUUID()

  async register(workspaceId: string, displayName: string, handle: FileSystemDirectoryHandle) {
    const existing = this.workspaces.get(workspaceId)
    if (existing) {
      existing.displayName = displayName
      existing.handle = handle
      await this.connect()
      return
    }
    const alreadyConnected = this.socket?.readyState === WebSocket.OPEN
    this.workspaces.set(workspaceId, {
      workspaceId,
      displayName,
      handle,
      revision: newRevision()
    })
    const registered = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.registrationWaiters.delete(workspaceId)
        reject(new Error('workspace broker registration timed out'))
      }, 5_000)
      this.registrationWaiters.set(workspaceId, { resolve, reject, timer })
    })
    try {
      await this.connect()
      if (alreadyConnected) this.sendRegistration(this.workspaces.get(workspaceId)!)
      await registered
    } catch (error) {
      const waiter = this.registrationWaiters.get(workspaceId)
      if (waiter) window.clearTimeout(waiter.timer)
      this.registrationWaiters.delete(workspaceId)
      this.workspaces.delete(workspaceId)
      throw error
    }
  }

  unregister(workspaceId: string) {
    const waiter = this.registrationWaiters.get(workspaceId)
    if (waiter) {
      window.clearTimeout(waiter.timer)
      waiter.reject(new Error('workspace registration was cancelled'))
      this.registrationWaiters.delete(workspaceId)
    }
    if (!this.workspaces.delete(workspaceId)) return
    this.send({ kind: 'workspace.unregister', payload: { workspaceId } })
    if (this.workspaces.size === 0) {
      this.reconnectAttempts = 0
      this.stopReconnect()
    }
  }

  revision(workspaceId: string): WorkspaceRevision | undefined {
    return this.workspaces.get(workspaceId)?.revision
  }

  advanceRevision(workspaceId: string): WorkspaceRevision {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`workspace handle is not registered: ${workspaceId}`)
    const revision = newRevision()
    workspace.revision = revision
    return revision
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(brokerUrl(this.clientId))
      this.socket = socket
      socket.addEventListener('open', () => {
        this.stopReconnect()
        this.reconnectAttempts = 0
        for (const workspace of this.workspaces.values()) this.sendRegistration(workspace)
        this.startHeartbeat()
        resolve()
      })
      socket.addEventListener('message', (event) => void this.onMessage(String(event.data)))
      socket.addEventListener('error', () => reject(new Error('workspace broker WebSocket failed')))
      socket.addEventListener('close', () => {
        this.stopHeartbeat()
        for (const waiter of this.registrationWaiters.values()) {
          window.clearTimeout(waiter.timer)
          waiter.reject(new Error('workspace broker disconnected before registration completed'))
        }
        this.registrationWaiters.clear()
        this.socket = undefined
        this.connectPromise = undefined
        this.reconnectAttempts += 1
        this.scheduleReconnect()
      })
    }).finally(() => {
      this.connectPromise = undefined
    })
    return this.connectPromise
  }

  private async onMessage(raw: string) {
    const message = JSON.parse(raw) as { kind: string; payload?: unknown }
    if (message.kind === 'workspace.registered') {
      const workspaceId = (message.payload as { workspaceId?: unknown } | undefined)?.workspaceId
      if (typeof workspaceId === 'string') {
        const waiter = this.registrationWaiters.get(workspaceId)
        if (waiter) {
          window.clearTimeout(waiter.timer)
          this.registrationWaiters.delete(workspaceId)
          waiter.resolve()
        }
      }
      return
    }
    if (message.kind !== 'workspace.operation.request' || !message.payload) return
    const request = message.payload as WorkspaceOperationRequest
    const workspace = this.workspaces.get(request.workspaceId)
    if (!workspace) {
      this.sendResult(request, undefined, new Error('workspace handle is not registered'))
      return
    }
    try {
      const data = await executeOperation(workspace, request)
      this.sendResult(request, data)
    } catch (error) {
      this.sendResult(request, undefined, error)
    }
  }

  private sendRegistration(workspace: RegisteredWorkspace) {
    this.send({
      kind: 'workspace.register',
      payload: {
        workspaceId: workspace.workspaceId,
        providerKind: 'browser_broker',
        capabilities: { read: true, write: true, command: false, test: false },
        displayName: workspace.displayName
      }
    })
  }

  private sendResult(request: WorkspaceOperationRequest, data?: unknown, error?: unknown) {
    const result: WorkspaceOperationResult = {
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      operation: request.operation,
      status: error ? 'error' : 'ok',
      ...(error
        ? { error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) } }
        : { data })
    }
    this.send({ kind: 'workspace.operation.result', payload: result })
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      for (const workspaceId of this.workspaces.keys()) {
        this.send({ kind: 'workspace.heartbeat', payload: { workspaceId } })
      }
    }, 15_000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private scheduleReconnect() {
    const delay = workspaceBrokerReconnectDelay(
      this.workspaces.size,
      this.reconnectTimer !== undefined,
      this.reconnectAttempts
    )
    if (delay === undefined) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private stopReconnect() {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private send(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(payload))
  }
}

async function executeOperation(workspace: RegisteredWorkspace, request: WorkspaceOperationRequest): Promise<unknown> {
  if (request.operation === 'capabilities') return { read: true, write: true, command: false, test: false }
  if (request.operation === 'getRevision') return workspace.revision
  if (request.operation === 'readFile') {
    return browserReadFile({ root: workspace.handle, input: request.input, revision: workspace.revision, digest })
  }
  if (request.operation === 'statFile') {
    return browserStatFile({ root: workspace.handle, input: request.input, revision: workspace.revision, digest })
  }
  if (request.operation === 'listDirectory') {
    return browserListDirectory({
      root: directoryAdapter(workspace.handle),
      input: request.input,
      revision: workspace.revision,
      digestFile: async (path) => {
        const result = await browserReadFile({ root: workspace.handle, input: { path }, revision: workspace.revision, digest })
        return { hashValue: result.hash.value, size: result.byteLength }
      }
    })
  }
  if (request.operation === 'searchText') return searchText(workspace, request.input)
  return runBrowserWorkspaceWrite(workspace.workspaceId, async () => {
    const conflicts = await validateHashes(workspace, request.input)
    if (conflicts.length) {
      return { ok: false, changeSetId: request.input.id, revision: workspace.revision, conflicts }
    }
    const nextRevision = newRevision()
    const result = await browserApplyChangeSet({ root: workspace.handle, changeSet: request.input, nextRevision })
    workspace.revision = nextRevision
    return result
  })
}

function directoryAdapter(handle: FileSystemDirectoryHandle): import('./workspaceBrokerListDirectory').BrowserListDirectoryHandle {
  return {
    entries: async function* () {
      for await (const [, entry] of handle.entries()) yield { name: entry.name, kind: entry.kind }
    },
    getDirectoryHandle: async (name) => directoryAdapter(await handle.getDirectoryHandle(name))
  }
}

async function searchText(
  workspace: RegisteredWorkspace,
  input: Extract<WorkspaceOperationRequest, { operation: 'searchText' }>['input']
) {
  const matches: SearchTextMatch[] = []
  const maxResults = Math.max(1, input.maxResults ?? 100)
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
  if (needle.length === 0) return { matches, truncated: false, revision: workspace.revision }
  const searchRoot = assertSafeBrowserWorkspacePath(input.path ?? '')
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [, entry] of dir.entries()) {
      if (matches.length >= maxResults) return
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.kind === 'directory') {
        if (isGeneratedWorkspaceDirectory(entry.name) || isSensitiveBrowserWorkspacePath(path)) continue
        await walk(entry, path)
        continue
      }
      if (isSensitiveBrowserWorkspacePath(path)) continue
      const file = await entry.getFile()
      if (file.size > 512 * 1024) continue
      const lines = (await file.text()).split('\n')
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        const line = lines[index]
        const column = (input.caseSensitive ? line : line.toLowerCase()).indexOf(needle)
        if (column >= 0) matches.push({ path, line: index + 1, column: column + 1, preview: line.slice(0, 240) })
      }
    }
  }
  const root = await resolveSearchRoot(workspace.handle, searchRoot)
  await walk(root, searchRoot)
  return { matches, truncated: matches.length >= maxResults, revision: workspace.revision }
}

async function resolveSearchRoot(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of path ? path.split('/') : []) current = await current.getDirectoryHandle(segment)
  return current
}

async function validateHashes(
  workspace: RegisteredWorkspace,
  changeSet: Extract<WorkspaceOperationRequest, { operation: 'applyChangeSet' }>['input']
) {
  const conflicts: WorkspaceConflictError[] = []
  for (const change of changeSet.changes) {
    if (change.operation === 'create') {
      try {
        const metadata = await browserStatFile({
          root: workspace.handle,
          input: { path: change.path },
          revision: workspace.revision,
          digest
        })
        conflicts.push({
          code: WORKSPACE_BASE_HASH_MISMATCH,
          message: `create target already exists: ${change.path}`,
          changeSetId: changeSet.id,
          operation: 'create',
          path: change.path,
          ...(metadata.kind === 'file' ? { actualHash: metadata.hash } : {}),
          actualRevision: workspace.revision
        })
      } catch (error) {
        if (!(error instanceof BrowserWorkspaceFileNotFoundError)) throw error
      }
      continue
    }
    const path = change.operation === 'move' ? change.fromPath : change.path
    const metadata = await browserStatFile({ root: workspace.handle, input: { path }, revision: workspace.revision, digest })
    const actualHash = metadata.kind === 'file' ? metadata.hash : undefined
    if (actualHash?.value === change.expectedHash.value) continue
    conflicts.push({
      code: 'WORKSPACE_BASE_HASH_MISMATCH',
      message: `workspace file changed since review: ${path}`,
      changeSetId: changeSet.id,
      operation: change.operation,
      path,
      baseHash: change.expectedHash,
      actualHash,
      actualRevision: workspace.revision
    })
  }
  return conflicts
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newRevision(): WorkspaceRevision {
  return { id: crypto.randomUUID(), observedAt: new Date().toISOString() }
}

function brokerUrl(clientId: string): string {
  const url = new URL(apiBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/workspace-broker'
  url.search = new URLSearchParams({ clientId }).toString()
  return url.toString()
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return 'WORKSPACE_FILE_NOT_FOUND'
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'WORKSPACE_PERMISSION_REQUIRED'
    }
  }
  return typeof error === 'object' && error && 'code' in error ? String(error.code) : 'WORKSPACE_OPERATION_FAILED'
}

export const workspaceBrokerSocket = new WorkspaceBrokerSocket()
