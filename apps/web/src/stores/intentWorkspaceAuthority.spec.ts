import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { authorityKey, normalizeAuthority, useIntentWorkspaceAuthorityStore } from './intentWorkspaceAuthority'

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const view = (revision = 1, enabled = true, sessionId = 's1', epoch = 'epoch') => ({ sessionId, dataEpoch: epoch,
  sessionRevision: revision, bindingHash: 'binding', enabled, authority: { bindingHash: 'binding', grant: { id: 'grant',
    effect: 'read_workspace', resource: { kind: 'workspace', refId: 'workspace' }, revision, sourceEventId: 'source',
    ...(!enabled ? { revokedAt: '2026-10-19T00:00:00Z' } : {}) } } })
const key = authorityKey('s1', 'epoch')
function ready() { const store = useIntentWorkspaceAuthorityStore(); store.record(normalizeAuthority(view(), 's1', 'epoch')); return store }
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

it('preserves original request after uncertain transport and does not retarget it on navigation', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    if (calls.length === 1) throw new TypeError('Failed to fetch')
    return response(view(2, false))
  }))
  const store = ready(); store.prepare('s1', 'epoch', 'revoke')
  await expect(store.submit('s1', 'epoch')).rejects.toThrow()
  store.record(normalizeAuthority(view(9, true, 's2'), 's2', 'epoch'))
  expect(() => store.prepare('s1', 'epoch', 'grant')).toThrow('尚未确认')
  await store.submit('s1', 'epoch')
  expect(calls[0]).toEqual(calls[1]); expect(calls[0].url).toContain('/sessions/s1/')
  expect(calls[0].body).toMatchObject({ action: 'revoke', dataEpoch: 'epoch', expectedGrantRevision: 1, expectedBindingHash: 'binding' })
  expect(store.views[key].enabled).toBe(false); expect(store.pending[key]).toBeUndefined()
})

it('409 refreshes current state and requires a new explicit action instead of automatically retrying', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts++; return new Response(JSON.stringify({ message: 'INTENT_AUTHORITY_REVISION_CONFLICT' }), { status: 409 }) }
    return response(view(4, false))
  }))
  const store = ready(); store.prepare('s1', 'epoch', 'revoke')
  const originalKey = store.pending[key].payload.idempotencyKey
  await expect(store.submit('s1', 'epoch')).rejects.toMatchObject({ status: 409 })
  expect(posts).toBe(1); expect(store.views[key].authority?.grant.revision).toBe(4); expect(store.pending[key]).toBeUndefined()
  store.prepare('s1', 'epoch', 'grant')
  expect(store.pending[key].payload).toMatchObject({ expectedGrantRevision: 4, action: 'grant' })
  expect(store.pending[key].payload.idempotencyKey).not.toBe(originalKey)
})

it('late GET cannot replace the state returned by a committed mutation', async () => {
  let release!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST' ? response(view(2, false)) : new Promise<Response>(done => { release = done })))
  const store = ready(); store.prepare('s1', 'epoch', 'revoke')
  const reading = store.refresh('s1', 'epoch')
  await store.submit('s1', 'epoch')
  release(response(view(1, true))); await reading
  expect(store.views[key].enabled).toBe(false); expect(store.views[key].sessionRevision).toBe(2)
})

it('rejects foreign epochs, malformed authority and inconsistent enabled states', () => {
  for (const input of [null, {}, view(1, true, 'foreign'), view(1, true, 's1', 'old'), { ...view(), authority: null },
    { ...view(), sessionRevision: 0 }, { ...view(), authority: { ...view().authority, grant: { ...view().authority.grant, effect: 'modify_source' } } }]) {
    expect(() => normalizeAuthority(input, 's1', 'epoch')).toThrow()
  }
})

it('failed refresh disables new mutations while a failed POST retains its bound request', async () => {
  const store = ready(); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  await expect(store.refresh('s1', 'epoch')).rejects.toThrow()
  expect(() => store.prepare('s1', 'epoch', 'revoke')).toThrow('刷新')
  store.stale[key] = false; store.prepare('s1', 'epoch', 'revoke')
  await expect(store.submit('s1', 'epoch')).rejects.toThrow()
  expect(store.pending[key].payload.action).toBe('revoke'); expect(store.busy[key]).toBe(false)
})

it('deduplicates simultaneous submissions and isolates the same session in a new epoch', async () => {
  let release!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(done => { release = done })); vi.stubGlobal('fetch', fetcher)
  const store = ready(); store.prepare('s1', 'epoch', 'revoke')
  const first = store.submit('s1', 'epoch')
  await expect(store.submit('s1', 'epoch')).rejects.toThrow('正在提交')
  await expect(store.submit('s1', 'new-epoch')).rejects.toThrow('没有可重试')
  release(response(view(2, false))); await first; expect(fetcher).toHaveBeenCalledTimes(1)
})
