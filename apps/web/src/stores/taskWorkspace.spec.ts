import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTaskWorkspaceStore } from './taskWorkspace'
import { apiGet, apiPage } from '@/api/client'
vi.mock('@/api/client', () => ({ apiGet: vi.fn(), apiPage: vi.fn() }))

describe('task workspace asynchronous isolation', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); sessionStorage.clear() })
  it('ignores late responses from the previous task', async () => {
    let releaseA!: (value: unknown) => void
    vi.mocked(apiPage).mockImplementation(async path => {
      if (path === '/workflow-runs/session/a') return await new Promise(resolve => { releaseA = resolve }) as never
      if (path === '/workflow-runs/session/b') return { items: [{ id: 'run-b' }], hasMore: false } as never
      return { items: [], hasMore: false }
    })
    vi.mocked(apiGet).mockImplementation(async path => path.endsWith('/tasks') ? [] : ({ run: { id: path.split('/').at(-1) }, nodeRuns: [], approvals: [] }) as never)
    const store = useTaskWorkspaceStore()
    const a = store.load('a')
    await store.load('b')
    releaseA({ items: [{ id: 'run-a' }], hasMore: false }); await a
    expect(store.sessionId).toBe('b')
    expect(store.runs.map(run => run.id)).toEqual(['run-b'])
    expect(store.selection.runId).toBe('run-b')
  })
  it('retains historical selection when new runs arrive', async () => {
    let ids = ['old']
    vi.mocked(apiPage).mockImplementation(async path => ({ items: path.includes('/workflow-runs/') ? ids.map(id => ({ id })) : [], hasMore: false }) as never)
    vi.mocked(apiGet).mockImplementation(async path => path.endsWith('/tasks') ? [] : ({ run: { id: path.split('/').at(-1) }, nodeRuns: [], approvals: [] }) as never)
    const store = useTaskWorkspaceStore(); await store.load('a')
    store.select({ nodeId: 'node-old', taskId: 'task-old' })
    ids = ['new', 'old']; await store.load('a')
    expect(store.selection).toMatchObject({ runId: 'old', nodeId: 'node-old', taskId: 'task-old' })
  })
  it('invalidates a cached catalog after a failed refresh', async () => {
    const store = useTaskWorkspaceStore()
    vi.mocked(apiPage).mockResolvedValueOnce({ items: [{ id: 'v1' }], hasMore: false } as never)
    await store.loadCatalog(); expect(store.catalog).toHaveLength(1)
    vi.mocked(apiPage).mockRejectedValueOnce(new Error('offline'))
    await store.loadCatalog()
    expect(store.catalog).toEqual([]); expect(store.catalogError).toBe('offline')
  })
  it('restores the selected historical run and attempt after reload', async () => {
    vi.mocked(apiPage).mockImplementation(async path => ({ items: path.includes('/workflow-runs/') ? [{ id: 'old' }, { id: 'new' }] : [], hasMore: false }) as never)
    vi.mocked(apiGet).mockImplementation(async path => path.endsWith('/tasks') ? [] : ({ run: { id: path.split('/').at(-1) }, nodeRuns: [], approvals: [] }) as never)
    const first = useTaskWorkspaceStore(); await first.load('a')
    first.select({ runId: 'new', nodeId: 'node', taskId: 'task', nodeRunId: 'attempt-2' })
    setActivePinia(createPinia())
    const restored = useTaskWorkspaceStore(); await restored.load('a')
    expect(restored.selection).toEqual({ runId: 'new', nodeId: 'node', taskId: 'task', nodeRunId: 'attempt-2' })
  })
})
