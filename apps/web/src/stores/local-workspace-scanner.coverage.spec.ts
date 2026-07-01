import test from 'node:test'
import assert from 'node:assert/strict'
import { scanDirectory, type DirectoryHandle } from './local-workspace-scanner'

type FakeFile = {
  size: number
  text: string
}

type FakeNode =
  | { kind: 'file'; name: string; file: FakeFile }
  | { kind: 'directory'; name: string; children: FakeNode[] }

function makeFileHandle(node: Extract<FakeNode, { kind: 'file' }>): FileSystemFileHandle {
  return {
    kind: 'file',
    name: node.name,
    async getFile() {
      return {
        size: node.file.size,
        async text() {
          return node.file.text
        }
      } as unknown as File
    }
  } as unknown as FileSystemFileHandle
}

function makeDirectoryHandle(node: Extract<FakeNode, { kind: 'directory' }>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: node.name,
    async *entries() {
      for (const child of node.children) {
        if (child.kind === 'directory') {
          yield [child.name, makeDirectoryHandle(child)] as const
        } else {
          yield [child.name, makeFileHandle(child)] as const
        }
      }
    }
  } as unknown as FileSystemDirectoryHandle
}

function file(name: string, text: string): FakeNode {
  return { kind: 'file', name, file: { size: text.length, text } }
}

function dir(name: string, children: FakeNode[]): FakeNode {
  return { kind: 'directory', name, children }
}

test('scanDirectory exposes coverage stats with skippedByReason aggregation', async () => {
  const root = makeDirectoryHandle({
    kind: 'directory',
    name: 'fake-root',
    children: [
      file('README.md', '# hi'),
      file('main.ts', 'export const a = 1\n'),
      file('.env', 'SECRET=1'),
      dir('node_modules', [file('lib.js', 'noop')]),
      { kind: 'file', name: 'big.ts', file: { size: 200_000, text: 'x'.repeat(200_000) } },
      { kind: 'file', name: 'image.png', file: { size: 100, text: 'binary-bytes' } }
    ]
  }) as DirectoryHandle

  const snapshot = await scanDirectory(root)
  assert.ok(snapshot.coverage, 'snapshot.coverage must be present')
  const coverage = snapshot.coverage!
  assert.equal(typeof coverage.totalEntriesSeen, 'number')
  assert.equal(typeof coverage.scannedEntries, 'number')
  assert.equal(typeof coverage.readableFiles, 'number')
  assert.ok(coverage.totalEntriesSeen >= 6, `totalEntriesSeen >= 6, got ${coverage.totalEntriesSeen}`)
  assert.equal(coverage.readableFiles, 2, 'should read README.md + main.ts')

  const { skippedByReason } = coverage
  assert.equal(skippedByReason.ignored_directory, 1, 'node_modules → ignored_directory')
  assert.equal(skippedByReason.sensitive, 1, '.env → sensitive')
  assert.equal(skippedByReason.too_large, 1, 'big.ts → too_large')
  assert.equal(skippedByReason.binary, 1, 'image.png → binary')
})
