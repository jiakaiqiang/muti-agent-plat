import type {
  WorkspaceFileSnapshot,
  WorkspaceManifestCoverage,
  WorkspaceSkippedReason,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared'

export type DirectoryHandle = FileSystemDirectoryHandle

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage'
])
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

export async function scanDirectory(root: DirectoryHandle): Promise<WorkspaceSnapshot> {
  const files: WorkspaceFileSnapshot[] = []
  const skipped: WorkspaceSnapshot['skipped'] = []
  const tree: WorkspaceTreeNode[] = []
  let totalBytes = 0
  let entryCount = 0
  let totalEntriesSeen = 0
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
      totalEntriesSeen += 1
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
  const skippedByReason: Partial<Record<WorkspaceSkippedReason, number>> = {}
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1
  }
  const coverage: WorkspaceManifestCoverage = {
    totalEntriesSeen,
    scannedEntries: entryCount,
    readableFiles: readableCount,
    skippedByReason
  }
  return {
    rootName: root.name,
    scannedAt: new Date().toISOString(),
    fileCount: entryCount,
    totalBytes,
    tree,
    files,
    skipped,
    detectedStack: detectStack(files),
    entrypoints: detectEntrypoints(files),
    coverage
  }
}
