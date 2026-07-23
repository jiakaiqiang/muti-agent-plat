import { describe, expect, it } from 'vitest'
import type { RuntimeFileChange, SessionWorkingDirectory } from '@/types/contracts'
import {
  detectFileChangeConflict,
  findCanonicalWorkspaceBinding,
  type WorkspaceBinding
} from '@/stores/localWorkspace'
import { runBrowserWorkspaceWrite } from '@/stores/workspaceWriteCoordinator'

function directory(id: string): SessionWorkingDirectory {
  return {
    kind: 'browser_local',
    id,
    name: 'shared-project',
    selectedAt: '2026-07-14T00:00:00.000Z'
  }
}

describe('canonical browser workspace identity', () => {
  it('reuses the existing workspaceId when the picker returns the same physical directory', async () => {
    const originalHandle = { name: 'shared-project' } as FileSystemDirectoryHandle
    const pickedAgain = {
      name: 'shared-project',
      isSameEntry: async (other: FileSystemHandle) => other === originalHandle
    } as FileSystemDirectoryHandle
    const binding: WorkspaceBinding = { directory: directory('workspace-stable'), handle: originalHandle }

    const resolved = await findCanonicalWorkspaceBinding([binding], pickedAgain)

    expect(resolved?.directory.id).toBe('workspace-stable')
  })
})

describe('browser writeback conflict detection', () => {
  it('rejects create over different existing content but keeps identical create idempotent', () => {
    const change = {
      operation: 'create',
      path: 'src/new.ts',
      content: 'export const value = 1\n'
    } satisfies RuntimeFileChange

    expect(detectFileChangeConflict(change, 'export const value = 2\n')).toBe(true)
    expect(detectFileChangeConflict(change, 'export const value = 1\n')).toBe(false)
    expect(detectFileChangeConflict(change, undefined)).toBe(false)
  })

  it('fails closed when an update has no immutable baseline content', () => {
    const change = {
      operation: 'update',
      path: 'src/main.ts',
      content: 'new'
    } satisfies RuntimeFileChange

    expect(detectFileChangeConflict(change, 'current')).toBe(true)
  })

  it('allows an update only while the current file still matches its baseline', () => {
    const change = {
      operation: 'update',
      path: 'src/main.ts',
      previousContent: 'base\r\n',
      content: 'next\n'
    } satisfies RuntimeFileChange

    expect(detectFileChangeConflict(change, 'base\n')).toBe(false)
    expect(detectFileChangeConflict(change, 'changed\n')).toBe(true)
  })
})

describe('browser workspace write coordination', () => {
  it('serializes writes from different Sessions that share one workspaceId', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const first = runBrowserWorkspaceWrite('workspace-stable', async () => {
      order.push('first:start')
      markFirstStarted()
      await firstGate
      order.push('first:end')
    })
    const second = runBrowserWorkspaceWrite('workspace-stable', async () => {
      order.push('second:start')
      order.push('second:end')
    })

    await firstStarted
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})
