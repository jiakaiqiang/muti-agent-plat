import { defineStore } from 'pinia'
import type { RuntimeFileChange, SessionWorkingDirectory, WorkspaceSnapshot } from '@/types/contracts'
import { scanDirectory, type DirectoryHandle } from './local-workspace-scanner'
import { workspaceBrokerSocket } from './workspaceBrokerSocket'
import { runBrowserWorkspaceWrite } from './workspaceWriteCoordinator'

export type WorkspaceBinding = {
  directory: SessionWorkingDirectory
  handle: DirectoryHandle
}

export type FileChangeApplyResult = {
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

export async function findCanonicalWorkspaceBinding(
  bindings: readonly WorkspaceBinding[],
  handle: DirectoryHandle
): Promise<WorkspaceBinding | undefined> {
  const unique = new Map(bindings.map((binding) => [binding.directory.id, binding]))
  for (const binding of unique.values()) {
    if (binding.handle === handle) return binding
    if (typeof handle.isSameEntry === 'function' && await handle.isSameEntry(binding.handle)) return binding
  }
  return undefined
}

async function snapshotBinding(binding: WorkspaceBinding): Promise<WorkspaceSnapshot> {
  const snapshot = await scanDirectory(binding.handle)
  const revision = workspaceBrokerSocket.revision(binding.directory.id)
  return revision ? { ...snapshot, revision } : snapshot
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
 * When previousContent is absent we cannot prove safety, so updates and deletes fail closed.
 */
export function detectFileChangeConflict(change: RuntimeFileChange, currentContent?: string): boolean {
  if (change.operation === 'create') {
    return currentContent !== undefined && normalizeContent(currentContent) !== normalizeContent(change.content)
  }
  if (change.previousContent === undefined || change.previousContent === null) {
    return true
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
      const existing = await findCanonicalWorkspaceBinding(
        [
          ...(this.pendingBinding ? [this.pendingBinding] : []),
          ...Object.values(this.bindingsBySessionId).filter((binding): binding is WorkspaceBinding => Boolean(binding))
        ],
        handle
      )
      const pendingBinding = existing
        ? { directory: existing.directory, handle }
        : { directory: createWorkingDirectory(handle), handle }
      await workspaceBrokerSocket.register(
        pendingBinding.directory.id,
        pendingBinding.directory.name,
        pendingBinding.handle
      )
      this.pendingBinding = pendingBinding
      return this.pendingBinding.directory
    },
    clearPendingDirectory() {
      if (this.pendingBinding) {
        const workspaceId = this.pendingBinding.directory.id
        const sharedBySession = Object.values(this.bindingsBySessionId)
          .some((binding) => binding?.directory.id === workspaceId)
        if (!sharedBySession) workspaceBrokerSocket.unregister(workspaceId)
      }
      this.pendingBinding = undefined
    },
    bindPendingDirectoryToSession(sessionId: string) {
      if (!this.pendingBinding) return undefined
      this.bindingsBySessionId[sessionId] = this.pendingBinding
      const binding = this.pendingBinding
      this.pendingBinding = undefined
      return this.bindingsBySessionId[sessionId]?.directory
    },
    releaseSessionWorkspace(sessionId: string) {
      const binding = this.bindingsBySessionId[sessionId]
      if (!binding) return
      delete this.bindingsBySessionId[sessionId]
      const workspaceId = binding.directory.id
      const stillReferenced = this.pendingBinding?.directory.id === workspaceId || Object.values(this.bindingsBySessionId)
        .some((candidate) => candidate?.directory.id === workspaceId)
      if (!stillReferenced) workspaceBrokerSocket.unregister(workspaceId)
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
      return snapshotBinding(this.pendingBinding)
    },
    async scanSessionWorkspace(sessionId: string) {
      const binding = this.bindingsBySessionId[sessionId]
      if (!binding) return undefined
      const allowed = await ensurePermission(binding.handle)
      if (!allowed) {
        throw new Error('Read/write permission was not granted for the selected directory.')
      }
      return snapshotBinding(binding)
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
        const result = {
          applied: 0,
          skipped: fileChanges.length,
          errors: [
            'No local directory permission is available for this session. Select the working directory again before applying file changes.'
          ]
        }
        this.lastApplyResultBySessionId[sessionId] = result
        return result
      }

      const allowed = await ensurePermission(binding.handle)
      if (!allowed) {
        const result = {
          applied: 0,
          skipped: fileChanges.length,
          errors: ['The browser did not grant write permission for this directory.']
        }
        this.lastApplyResultBySessionId[sessionId] = result
        return result
      }

      const result = await runBrowserWorkspaceWrite(binding.directory.id, async () => {
        const errors: string[] = []
        let applied = 0
        for (const change of fileChanges) {
          try {
            const currentContent = await readCurrentContent(binding.handle, change.path)
            if (detectFileChangeConflict(change, currentContent)) {
              errors.push(`${change.path}: workspace changed since this proposal was created`)
              continue
            }
            await applyFileChange(binding.handle, change)
            applied += 1
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
        if (applied > 0) workspaceBrokerSocket.advanceRevision(binding.directory.id)
        return { applied, skipped: fileChanges.length - applied, errors }
      })

      if (!result.errors.length && result.applied === fileChanges.length) {
        this.appliedArtifactIds[artifactId] = true
      }
      this.lastApplyResultBySessionId[sessionId] = result
      return result
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
            conflict: detectFileChangeConflict(change, currentContent)
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
        const result = {
          applied: 0,
          skipped: selected.size,
          errors: ['No local directory permission is available for this session. Select the working directory again.']
        }
        this.lastApplyResultBySessionId[sessionId] = result
        return result
      }
      const allowed = await ensurePermission(binding.handle)
      if (!allowed) {
        const result = {
          applied: 0,
          skipped: selected.size,
          errors: ['The browser did not grant write permission for this directory.']
        }
        this.lastApplyResultBySessionId[sessionId] = result
        return result
      }

      const queue = this.pendingFileChangesBySessionId[sessionId] ?? []
      const result = await runBrowserWorkspaceWrite(binding.directory.id, async () => {
        const errors: string[] = []
        let applied = 0
        let skipped = 0
        for (const item of queue) {
          if (this.appliedArtifactIds[item.artifactId]) continue
          let appliedInArtifact = 0
          let failedInArtifact = false
          for (const change of item.fileChanges) {
            if (!selected.has(change.path)) {
              skipped += 1
              continue
            }
            try {
              const currentContent = await readCurrentContent(binding.handle, change.path)
              if (detectFileChangeConflict(change, currentContent)) {
                failedInArtifact = true
                skipped += 1
                errors.push(`${change.path}: workspace changed since this proposal was created`)
                continue
              }
              await applyFileChange(binding.handle, change)
              applied += 1
              appliedInArtifact += 1
            } catch (error) {
              failedInArtifact = true
              errors.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (appliedInArtifact === item.fileChanges.length && !failedInArtifact) {
            this.appliedArtifactIds[item.artifactId] = true
          }
        }
        if (applied > 0) workspaceBrokerSocket.advanceRevision(binding.directory.id)
        return { applied, skipped, errors }
      })

      this.pendingFileChangesBySessionId[sessionId] = queue.filter((item) => !this.appliedArtifactIds[item.artifactId])
      this.lastApplyResultBySessionId[sessionId] = result
      return result
    }
  }
})
