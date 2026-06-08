import { defineStore } from 'pinia'
import type {
  RuntimeFileChange,
  SessionWorkingDirectory,
  WorkspaceFileSnapshot,
  WorkspaceSkippedReason,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@/types/contracts'

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

export type PendingArtifactFileChanges = {
  artifactId: string
  title?: string
  fileChanges: RuntimeFileChange[]
  createdAt: string
}

type FileSystemPermissionMode = 'read' | 'readwrite'

type FileSystemHandlePermissionDescriptor = {
  mode?: FileSystemPermissionMode
}

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    showDirectoryPicker?: () => Promise<DirectoryHandle>
  }

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage'])
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.vue',
  '.yml',
  '.yaml',
  '.txt'
])
const configFileNames = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'nest-cli.json'
])
const maxScannedEntries = 350
const maxReadableFiles = 80
const maxSingleFileBytes = 80_000
const maxTotalContentBytes = 550_000

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

function extensionOf(path: string) {
  const name = path.split('/').at(-1) ?? path
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function isSensitivePath(path: string) {
  const name = path.split('/').at(-1)?.toLowerCase() ?? path.toLowerCase()
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name.includes('secret') ||
    name.includes('private-key') ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.p12') ||
    name.endsWith('.crt')
  )
}

function languageForPath(path: string) {
  const extension = extensionOf(path)
  return (
    {
      '.css': 'css',
      '.html': 'html',
      '.js': 'javascript',
      '.json': 'json',
      '.jsx': 'javascriptreact',
      '.md': 'markdown',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.vue': 'vue',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.txt': 'text'
    }[extension] ?? undefined
  )
}

function shouldReadTextFile(path: string) {
  const name = path.split('/').at(-1) ?? path
  return configFileNames.has(name) || textExtensions.has(extensionOf(path))
}

function detectStack(files: WorkspaceFileSnapshot[]) {
  const paths = new Set(files.map((file) => file.path))
  const packageJson = files.find((file) => file.path.endsWith('package.json'))?.content ?? ''
  return [
    paths.has('package.json') ? 'node' : undefined,
    packageJson.includes('"vue"') ? 'vue' : undefined,
    packageJson.includes('"@nestjs/') ? 'nestjs' : undefined,
    packageJson.includes('"vite"') ? 'vite' : undefined,
    paths.has('tsconfig.json') ? 'typescript' : undefined
  ].filter((item): item is string => Boolean(item))
}

function detectEntrypoints(files: WorkspaceFileSnapshot[]) {
  const likely = [
    'package.json',
    'src/main.ts',
    'src/main.tsx',
    'src/App.vue',
    'apps/web/src/main.ts',
    'apps/server/src/main.ts',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md'
  ]
  const paths = new Set(files.map((file) => file.path))
  return likely.filter((path) => paths.has(path))
}

async function scanDirectory(root: DirectoryHandle): Promise<WorkspaceSnapshot> {
  const files: WorkspaceFileSnapshot[] = []
  const skipped: WorkspaceSnapshot['skipped'] = []
  const tree: WorkspaceTreeNode[] = []
  let totalBytes = 0
  let entryCount = 0
  let readableCount = 0
  let totalContentBytes = 0

  async function scan(handle: DirectoryHandle, pathPrefix: string, target: WorkspaceTreeNode[]) {
    const entries: Array<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> = []
    for await (const entry of handle.entries()) {
      entries.push(entry)
    }
    entries.sort(([leftName], [rightName]) => leftName.localeCompare(rightName))

    for (const [name, child] of entries) {
      const path = pathPrefix ? `${pathPrefix}/${name}` : name
      if (entryCount >= maxScannedEntries) {
        skipped.push({ path, reason: 'limit_exceeded' })
        continue
      }
      entryCount += 1

      if (child.kind === 'directory') {
        const node: WorkspaceTreeNode = { path, kind: 'directory', children: [] }
        target.push(node)
        if (ignoredDirectories.has(name)) {
          skipped.push({ path, reason: 'ignored_directory' })
          continue
        }
        await scan(child, path, node.children ?? [])
        continue
      }

      const node: WorkspaceTreeNode = { path, kind: 'file' }
      target.push(node)
      if (isSensitivePath(path)) {
        skipped.push({ path, reason: 'sensitive' })
        continue
      }

      try {
        const file = await child.getFile()
        totalBytes += file.size
        if (!shouldReadTextFile(path)) {
          skipped.push({ path, reason: 'binary' })
          continue
        }
        if (file.size > maxSingleFileBytes) {
          skipped.push({ path, reason: 'too_large', detail: `${file.size} bytes` })
          continue
        }
        if (readableCount >= maxReadableFiles || totalContentBytes + file.size > maxTotalContentBytes) {
          skipped.push({ path, reason: 'limit_exceeded' })
          continue
        }
        const content = await file.text()
        readableCount += 1
        totalContentBytes += content.length
        files.push({
          path,
          size: file.size,
          language: languageForPath(path),
          content
        })
      } catch (error) {
        skipped.push({ path, reason: 'read_error', detail: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  await scan(root, '', tree)
  return {
    rootName: root.name,
    scannedAt: new Date().toISOString(),
    fileCount: entryCount,
    totalBytes,
    tree,
    files,
    skipped,
    detectedStack: detectStack(files),
    entrypoints: detectEntrypoints(files)
  }
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
    }
  }
})
