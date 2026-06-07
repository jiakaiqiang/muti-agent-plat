import { defineStore } from 'pinia'
import type { RuntimeFileChange, SessionWorkingDirectory } from '@/types/contracts'

type DirectoryHandle = FileSystemDirectoryHandle

type WorkspaceBinding = {
  directory: SessionWorkingDirectory
  handle: DirectoryHandle
}

type FileChangeApplyResult = {
  applied: number
  skipped: number
  errors: string[]
}

type FileSystemPermissionMode = 'read' | 'readwrite'

type FileSystemHandlePermissionDescriptor = {
  mode?: FileSystemPermissionMode
}

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: () => Promise<DirectoryHandle>
  }

function browserSupportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

function createWorkingDirectory(handle: DirectoryHandle): SessionWorkingDirectory {
  return {
    kind: 'browser_local',
    id: crypto.randomUUID(),
    name: handle.name,
    selectedAt: new Date().toISOString()
  }
}

function safePathParts(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length) {
    throw new Error('File change path is empty.')
  }
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`File change path must stay inside the selected directory: ${path}`)
  }
  return parts
}

async function ensurePermission(handle: DirectoryHandle) {
  const descriptor: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
  const current = await handle.queryPermission?.(descriptor)
  if (current === 'granted') return true
  const requested = await handle.requestPermission?.(descriptor)
  return requested === 'granted'
}

async function directoryForPath(root: DirectoryHandle, parts: string[], create: boolean) {
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part, { create })
  }
  return current
}

async function applyFileChange(root: DirectoryHandle, change: RuntimeFileChange) {
  const parts = safePathParts(change.path)
  const parent = await directoryForPath(root, parts, change.operation !== 'delete')
  const name = parts.at(-1)
  if (!name) {
    throw new Error(`File change path is invalid: ${change.path}`)
  }

  if (change.operation === 'delete') {
    await parent.removeEntry(name)
    return
  }

  const file = await parent.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(change.content ?? '')
  await writable.close()
}

export const useLocalWorkspaceStore = defineStore('localWorkspace', {
  state: () => ({
    bindingsBySessionId: {} as Record<string, WorkspaceBinding | undefined>,
    pendingBinding: undefined as WorkspaceBinding | undefined,
    appliedArtifactIds: {} as Record<string, true>,
    lastApplyResultBySessionId: {} as Record<string, FileChangeApplyResult | undefined>
  }),
  getters: {
    supportsDirectoryPicker: () => browserSupportsDirectoryPicker(),
    bindingForSession: (state) => (sessionId?: string) => (sessionId ? state.bindingsBySessionId[sessionId] : undefined),
    pendingDirectory: (state) => state.pendingBinding?.directory,
    directoryForSession: (state) => (sessionId?: string) =>
      sessionId ? state.bindingsBySessionId[sessionId]?.directory : undefined,
    applyResultForSession: (state) => (sessionId?: string) =>
      sessionId ? state.lastApplyResultBySessionId[sessionId] : undefined
  },
  actions: {
    async choosePendingDirectory() {
      const picker = (window as DirectoryPickerWindow).showDirectoryPicker
      if (!picker) {
        throw new Error('This browser does not support local directory selection. Use a Chromium-based browser.')
      }
      const handle = await picker()
      const allowed = await ensurePermission(handle)
      if (!allowed) {
        throw new Error('Read/write permission was not granted for the selected directory.')
      }
      this.pendingBinding = {
        directory: createWorkingDirectory(handle),
        handle
      }
      return this.pendingBinding.directory
    },
    clearPendingDirectory() {
      this.pendingBinding = undefined
    },
    bindPendingDirectoryToSession(sessionId: string) {
      if (!this.pendingBinding) return undefined
      this.bindingsBySessionId[sessionId] = this.pendingBinding
      this.pendingBinding = undefined
      return this.bindingsBySessionId[sessionId]?.directory
    },
    async applyArtifactFileChanges(sessionId: string, artifactId: string, fileChanges: RuntimeFileChange[] = []) {
      if (!fileChanges.length || this.appliedArtifactIds[artifactId]) {
        return
      }
      const binding = this.bindingsBySessionId[sessionId]
      if (!binding) {
        this.lastApplyResultBySessionId[sessionId] = {
          applied: 0,
          skipped: fileChanges.length,
          errors: [
            'No local directory permission is available for this session. Select the working directory again before applying file changes.'
          ]
        }
        return
      }

      const allowed = await ensurePermission(binding.handle)
      if (!allowed) {
        this.lastApplyResultBySessionId[sessionId] = {
          applied: 0,
          skipped: fileChanges.length,
          errors: ['The browser did not grant write permission for this directory.']
        }
        return
      }

      const errors: string[] = []
      let applied = 0
      for (const change of fileChanges) {
        try {
          await applyFileChange(binding.handle, change)
          applied += 1
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }

      if (!errors.length) {
        this.appliedArtifactIds[artifactId] = true
      }
      this.lastApplyResultBySessionId[sessionId] = {
        applied,
        skipped: fileChanges.length - applied,
        errors
      }
    }
  }
})
