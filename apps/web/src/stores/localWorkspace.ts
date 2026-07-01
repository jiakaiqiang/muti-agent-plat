import { defineStore } from 'pinia'
import type { RuntimeFileChange, SessionWorkingDirectory } from '@/types/contracts'
import { scanDirectory, type DirectoryHandle } from './local-workspace-scanner'

type WorkspaceBinding = {
  directory: SessionWorkingDirectory
  handle: DirectoryHandle
}

type FileChangeApplyResult = {
  applied: number
  skipped: number
  errors: string[]
}

export type PendingArtifactFileChanges = {
  artifactId: string
  title?: string
  fileChanges: RuntimeFileChange[]
  createdAt: string
}

/** A single change flattened out of its artifact, annotated for the review dialog. */
export type ReviewableFileChange = {
  artifactId: string
  artifactTitle?: string
  change: RuntimeFileChange
  /** Current on-disk content (undefined if the file does not exist). */
  currentContent?: string
  /** True when the file on disk differs from what the change expected to overwrite. */
  conflict: boolean
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

/** Reads the current on-disk content of a file, or undefined if it does not exist. */
async function readCurrentContent(root: DirectoryHandle, path: string): Promise<string | undefined> {
  let parts: string[]
  try {
    parts = safePathParts(path)
  } catch {
    return undefined
  }
  const name = parts.at(-1)
  if (!name) return undefined
  try {
    let current = root
    for (const part of parts.slice(0, -1)) {
      current = await current.getDirectoryHandle(part, { create: false })
    }
    const fileHandle = await current.getFileHandle(name, { create: false })
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return undefined
  }
}

function normalizeContent(value?: string | null) {
  return (value ?? '').replace(/\r\n/g, '\n')
}

/**
 * A conflict means the on-disk file no longer matches what the change expected.
 * - create: a file already exists with different content.
 * - update: disk differs from the change's previousContent (someone else edited it).
 * - delete: disk differs from previousContent.
 * When previousContent is absent we cannot prove a conflict, so we report none.
 */
function detectConflict(change: RuntimeFileChange, currentContent?: string): boolean {
  if (change.operation === 'create') {
    return currentContent !== undefined && normalizeContent(currentContent) !== normalizeContent(change.content)
  }
  if (change.previousContent === undefined || change.previousContent === null) {
    return false
  }
  if (currentContent === undefined) {
    // The file the change expected to modify/delete is gone.
    return true
  }
  return normalizeContent(currentContent) !== normalizeContent(change.previousContent)
}

export const useLocalWorkspaceStore = defineStore('localWorkspace', {
  state: () => ({
    bindingsBySessionId: {} as Record<string, WorkspaceBinding | undefined>,
    pendingBinding: undefined as WorkspaceBinding | undefined,
    appliedArtifactIds: {} as Record<string, true>,
    pendingFileChangesBySessionId: {} as Record<string, PendingArtifactFileChanges[] | undefined>,
    lastApplyResultBySessionId: {} as Record<string, FileChangeApplyResult | undefined>
  }),
  getters: {
    supportsDirectoryPicker: () => browserSupportsDirectoryPicker(),
    bindingForSession: (state) => (sessionId?: string) => (sessionId ? state.bindingsBySessionId[sessionId] : undefined),
    pendingDirectory: (state) => state.pendingBinding?.directory,
    directoryForSession: (state) => (sessionId?: string) =>
      sessionId ? state.bindingsBySessionId[sessionId]?.directory : undefined,
    applyResultForSession: (state) => (sessionId?: string) =>
      sessionId ? state.lastApplyResultBySessionId[sessionId] : undefined,
    pendingFileChangesForSession: (state) => (sessionId?: string) =>
      sessionId ? state.pendingFileChangesBySessionId[sessionId] ?? [] : []
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
    reusePendingDirectoryFromSession(sessionId?: string) {
      if (this.pendingBinding) return this.pendingBinding.directory
      const binding = sessionId ? this.bindingsBySessionId[sessionId] : undefined
      if (!binding) return undefined
      this.pendingBinding = binding
      return this.pendingBinding.directory
    },
    async scanPendingWorkspace() {
      if (!this.pendingBinding) return undefined
      const allowed = await ensurePermission(this.pendingBinding.handle)
      if (!allowed) {
        throw new Error('Read/write permission was not granted for the selected directory.')
      }
      return scanDirectory(this.pendingBinding.handle)
    },
    enqueueArtifactFileChanges(
      sessionId: string,
      artifactId: string,
      fileChanges: RuntimeFileChange[] = [],
      title?: string
    ) {
      if (!fileChanges.length || this.appliedArtifactIds[artifactId]) return
      const queue = this.pendingFileChangesBySessionId[sessionId] ?? []
      const existing = queue.find((item) => item.artifactId === artifactId)
      if (existing) return
      this.pendingFileChangesBySessionId[sessionId] = [
        ...queue,
        {
          artifactId,
          title,
          fileChanges,
          createdAt: new Date().toISOString()
        }
      ]
    },
    async applyQueuedFileChanges(sessionId: string) {
      const queue = this.pendingFileChangesBySessionId[sessionId] ?? []
      for (const item of queue) {
        await this.applyArtifactFileChanges(sessionId, item.artifactId, item.fileChanges)
      }
      this.pendingFileChangesBySessionId[sessionId] = queue.filter((item) => !this.appliedArtifactIds[item.artifactId])
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
    },
    /**
     * Reads on-disk content for every queued change and flags conflicts so the
     * user can review per-file diffs before writing. A conflict means the file
     * on disk no longer matches what the change expected to overwrite.
     */
    async reviewPendingFileChanges(sessionId: string): Promise<ReviewableFileChange[]> {
      const queue = this.pendingFileChangesBySessionId[sessionId] ?? []
      const binding = this.bindingsBySessionId[sessionId]
      const reviewable: ReviewableFileChange[] = []
      for (const item of queue) {
        if (this.appliedArtifactIds[item.artifactId]) continue
        for (const change of item.fileChanges) {
          const currentContent = binding ? await readCurrentContent(binding.handle, change.path) : undefined
          reviewable.push({
            artifactId: item.artifactId,
            artifactTitle: item.title,
            change,
            currentContent,
            conflict: detectConflict(change, currentContent)
          })
        }
      }
      return reviewable
    },
    /**
     * Writes only the changes the user selected (by path). Skips the rest and
     * keeps the queue entry alive when an artifact is only partially applied.
     */
    async applySelectedFileChanges(sessionId: string, selectedPaths: string[]) {
      const selected = new Set(selectedPaths)
      const binding = this.bindingsBySessionId[sessionId]
      if (!binding) {
        this.lastApplyResultBySessionId[sessionId] = {
          applied: 0,
          skipped: selected.size,
          errors: ['No local directory permission is available for this session. Select the working directory again.']
        }
        return
      }
      const allowed = await ensurePermission(binding.handle)
      if (!allowed) {
        this.lastApplyResultBySessionId[sessionId] = {
          applied: 0,
          skipped: selected.size,
          errors: ['The browser did not grant write permission for this directory.']
        }
        return
      }

      const queue = this.pendingFileChangesBySessionId[sessionId] ?? []
      const errors: string[] = []
      let applied = 0
      let skipped = 0
      for (const item of queue) {
        if (this.appliedArtifactIds[item.artifactId]) continue
        let appliedInArtifact = 0
        for (const change of item.fileChanges) {
          if (!selected.has(change.path)) {
            skipped += 1
            continue
          }
          try {
            await applyFileChange(binding.handle, change)
            applied += 1
            appliedInArtifact += 1
          } catch (error) {
            errors.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Mark the artifact fully applied only when every change in it was written.
        if (appliedInArtifact === item.fileChanges.length && !errors.length) {
          this.appliedArtifactIds[item.artifactId] = true
        }
      }

      this.pendingFileChangesBySessionId[sessionId] = queue.filter((item) => !this.appliedArtifactIds[item.artifactId])
      this.lastApplyResultBySessionId[sessionId] = { applied, skipped, errors }
    }
  }
})
