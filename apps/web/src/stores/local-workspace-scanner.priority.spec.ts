import test from 'node:test'
import assert from 'node:assert/strict'
import { scanDirectory, workspaceFileScanPriority, type DirectoryHandle } from './local-workspace-scanner'

type FakeNode =
  | { kind: 'file'; name: string; text: string }
  | { kind: 'directory'; name: string; children: FakeNode[] }

function makeDirectoryHandle(name: string, children: FakeNode[]): DirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const child of children) {
        if (child.kind === 'directory') {
          yield [child.name, makeDirectoryHandle(child.name, child.children)] as const
        } else {
          yield [
            child.name,
            {
              kind: 'file',
              name: child.name,
              async getFile() {
                return {
                  size: child.text.length,
                  async text() {
                    return child.text
                  }
                } as unknown as File
              }
            } as FileSystemFileHandle
          ] as const
        }
      }
    }
  } as DirectoryHandle
}

test('workspaceFileScanPriority ranks rules, entrypoints, config, and source before ordinary docs', () => {
  const ordinaryDocumentPriority = workspaceFileScanPriority('docs/guide.md')

  assert.ok(workspaceFileScanPriority('AGENTS.md') < ordinaryDocumentPriority)
  assert.ok(workspaceFileScanPriority('apps/web/src/main.ts') < ordinaryDocumentPriority)
  assert.ok(workspaceFileScanPriority('package.json') < ordinaryDocumentPriority)
  assert.ok(workspaceFileScanPriority('src/services/session.ts') < ordinaryDocumentPriority)
})

test('workspaceFileScanPriority uses deterministic category ordering', () => {
  assert.ok(workspaceFileScanPriority('nested/AGENTS.md') < workspaceFileScanPriority('src/main.ts'))
  assert.ok(workspaceFileScanPriority('src/main.ts') < workspaceFileScanPriority('vite.config.ts'))
  assert.ok(workspaceFileScanPriority('vite.config.ts') < workspaceFileScanPriority('src/app.ts'))
  assert.ok(workspaceFileScanPriority('src/app.ts') < workspaceFileScanPriority('docs/guide.md'))
})

test('scanDirectory reads src/main.ts before ordinary docs consume the 80-file content budget', async () => {
  const ordinaryDocs: FakeNode[] = Array.from({ length: 80 }, (_, index) => ({
    kind: 'file',
    name: `guide-${String(index).padStart(2, '0')}.md`,
    text: `# Guide ${index}`
  }))
  const root = makeDirectoryHandle('workspace', [
    ...ordinaryDocs,
    {
      kind: 'directory',
      name: 'src',
      children: [{ kind: 'file', name: 'main.ts', text: 'export const boot = true' }]
    }
  ])

  const snapshot = await scanDirectory(root)

  assert.equal(snapshot.files.some((file) => file.path === 'src/main.ts'), true)
  assert.equal(snapshot.files.length, 80)
})
