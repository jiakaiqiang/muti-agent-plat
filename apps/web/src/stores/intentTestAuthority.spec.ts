import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { IntentTestAuthorityView, IntentTestScript } from '@agent-cluster/shared'
import { normalizeTestAuthority, testAuthorityKey, useIntentTestAuthorityStore } from './intentTestAuthority'

export function authorityView(revision = 1, script: IntentTestScript | null = null, revoked = false, sessionId = 's1'): IntentTestAuthorityView {
  const availableBindings = (['test', 'test:unit', 'test:integration'] as const).map((script, index) => ({ runnerId: 'docker-npm-tests-v1' as const,
    resourceId: `test-runner:${String(index + 1).repeat(64)}`, bindingHash: String(index + 1).repeat(64), workspaceBindingHash: 'a'.repeat(64),
    workspaceId: 'workspace', imageId: `sha256:${'b'.repeat(64)}`, script }))
  const binding = availableBindings.find(row => row.script === script)
  return { sessionId, dataEpoch: 'epoch', sessionRevision: revision, enabled: Boolean(script && !revoked), availableBindings,
    authority: binding ? { binding, grant: { id: `isolated-test:${sessionId}:${binding.bindingHash}`, effect: 'run_tests',
      resource: { kind: 'test_runner', refId: binding.resourceId }, revision, sourceEventId: 'source', ...(revoked ? { revokedAt: 'now' } : {}) } } : null }
}
const response = (data: unknown) => new Response(JSON.stringify({ data }))
const key = testAuthorityKey('s1', 'epoch')
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => vi.unstubAllGlobals())
function ready() { const store = useIntentTestAuthorityStore(); store.record(normalizeTestAuthority(authorityView(), 's1', 'epoch')); return store }

it('report opt-in is bound to the test grant and survives reload without broadening authority', () => {
  const current = authorityView(2, 'test:unit'), authority = current.authority!
  authority.reportGrant = { id: `isolated-test-report:s1:${authority.binding.bindingHash}`, effect: 'write_artifact',
    resource: { kind: 'artifact', refId: `test-report:${authority.binding.bindingHash}` }, revision: 2, sourceEventId: authority.grant.sourceEventId }
  expect(normalizeTestAuthority(current, 's1', 'epoch').authority?.reportGrant).toEqual(authority.reportGrant)
  for (const patch of [{ revision: 1 }, { sourceEventId: 'foreign' }, { effect: 'modify_source' },
    { resource: { kind: 'artifact', refId: `test-report:${'f'.repeat(64)}` } }]) {
    expect(() => normalizeTestAuthority({ ...current, authority: { ...authority, reportGrant: { ...authority.reportGrant, ...patch } } }, 's1', 'epoch')).toThrow()
  }
  const store = ready(); store.prepare('s1', 'epoch', 'grant', 'test:unit', true)
  const payload = { ...store.pending[key].payload }
  setActivePinia(createPinia()); const restored = useIntentTestAuthorityStore(); restored.restorePending('s1', 'epoch')
  expect(restored.pending[key].payload).toEqual(payload); expect(payload.writeReport).toBe(true)
  expect(Object.keys(payload).sort()).toEqual(['action', 'script', 'dataEpoch', 'expectedBindingHash', 'expectedGrantRevision', 'idempotencyKey', 'writeReport'].sort())
})

it('removing report permission keeps the selected test and never sends report flags on revoke', () => {
  const store = ready(); store.record(normalizeTestAuthority(authorityView(2, 'test:unit'), 's1', 'epoch'))
  store.prepare('s1', 'epoch', 'grant', 'test:unit', false)
  expect(store.pending[key].payload).toMatchObject({ action: 'grant', script: 'test:unit', expectedGrantRevision: 2 })
  expect(store.pending[key].payload.writeReport).toBeUndefined()
  delete store.pending[key]; sessionStorage.clear(); store.prepare('s1', 'epoch', 'revoke', 'test:unit', true)
  expect(store.pending[key].payload.writeReport).toBeUndefined()
})

it('freezes the selected script and request identity across unknown results and a new store after tab reload', async () => {
  const requests: Array<{ url: string; body: string }> = []; let fail = true
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    requests.push({ url: String(url), body: init.body }); if (fail) throw new TypeError('network'); return response(authorityView(2, 'test:unit'))
  }))
  const store = ready(); store.prepare('s1', 'epoch', 'grant', 'test:unit')
  await expect(store.submit('s1', 'epoch')).rejects.toThrow()
  setActivePinia(createPinia()); const restored = useIntentTestAuthorityStore(); restored.restorePending('s1', 'epoch')
  expect(restored.pending[key].payload.script).toBe('test:unit')
  expect(() => restored.prepare('s1', 'epoch', 'grant', 'test')).toThrow('尚未确认')
  expect(restored.pending[testAuthorityKey('s1', 'other-epoch')]).toBeUndefined()
  fail = false; await restored.submit('s1', 'epoch')
  expect(requests[0]).toEqual(requests[1]); expect(restored.views[key].enabled).toBe(true)
  expect(sessionStorage.getItem(`intent-test-request:v1:${key}`)).toBeNull()
})

it('409 refreshes without reposting and a new explicit action gets the current revision', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST'
    ? (posts++, new Response(JSON.stringify({ message: 'conflict' }), { status: 409 })) : response(authorityView(3, 'test', true))))
  const store = ready(); store.prepare('s1', 'epoch', 'grant', 'test')
  const original = store.pending[key].payload.idempotencyKey
  await expect(store.submit('s1', 'epoch')).rejects.toMatchObject({ status: 409 })
  expect(posts).toBe(1); expect(store.pending[key]).toBeUndefined(); expect(store.views[key].authority?.grant.revision).toBe(3)
  store.prepare('s1', 'epoch', 'grant', 'test:unit')
  expect(store.pending[key].payload.expectedGrantRevision).toBe(3); expect(store.pending[key].payload.idempotencyKey).not.toBe(original)
})

it('revoke binds the authorized script even if the user selected another candidate and configuration disappeared', () => {
  const store = ready(), current = authorityView(4, 'test:unit'); current.availableBindings = []; current.enabled = false
  store.record(normalizeTestAuthority(current, 's1', 'epoch')); store.prepare('s1', 'epoch', 'revoke', 'test')
  expect(store.pending[key].payload).toMatchObject({ script: 'test:unit', expectedGrantRevision: 4, expectedBindingHash: '2'.repeat(64) })
})

it('late GET cannot overwrite committed mutation and concurrent submit sends one POST', async () => {
  let releaseRead!: (value: Response) => void, releasePost!: (value: Response) => void
  const fetcher = vi.fn(async (_url, init) => new Promise<Response>(resolve => { if (init?.method === 'POST') releasePost = resolve; else releaseRead = resolve }))
  vi.stubGlobal('fetch', fetcher); const store = ready(); store.prepare('s1', 'epoch', 'grant', 'test')
  const reading = store.refresh('s1', 'epoch'), sending = store.submit('s1', 'epoch')
  await expect(store.submit('s1', 'epoch')).rejects.toThrow('正在提交')
  releasePost(response(authorityView(2, 'test'))); await sending
  releaseRead(response(authorityView())); await reading
  expect(store.views[key].sessionRevision).toBe(2); expect(store.views[key].enabled).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2)
})

it('rejects foreign identity, duplicate candidates, forged effects, images and inconsistent enabled states', () => {
  const active = authorityView(1, 'test')
  for (const input of [null, {}, { ...active, sessionId: 'other' }, { ...active, dataEpoch: 'other' }, { ...active, authority: null },
    { ...active, availableBindings: [active.availableBindings[0], active.availableBindings[0]] },
    { ...active, availableBindings: [{ ...active.availableBindings[0], imageId: 'node:latest' }] },
    { ...active, authority: { ...active.authority, grant: { ...active.authority!.grant, effect: 'run_command' } } },
    { ...active, authority: { ...active.authority, grant: { ...active.authority!.grant, revokedAt: 'now' } } }]) {
    expect(() => normalizeTestAuthority(input, 's1', 'epoch')).toThrow()
  }
})

it('corrupted stored requests cannot retarget another session or smuggle command fields', () => {
  const store = ready(); store.prepare('s1', 'epoch', 'grant', 'test')
  const original = JSON.parse(sessionStorage.getItem(`intent-test-request:v1:${key}`)!)
  for (const bad of [{ ...original, sessionId: 'other' }, { ...original, payload: { ...original.payload, dataEpoch: 'other' } },
    { ...original, payload: { ...original.payload, command: 'arbitrary' } }]) {
    setActivePinia(createPinia()); sessionStorage.setItem(`intent-test-request:v1:${key}`, JSON.stringify(bad))
    const restored = useIntentTestAuthorityStore(); restored.restorePending('s1', 'epoch'); expect(restored.pending[key]).toBeUndefined()
  }
})

it('failed refresh blocks new mutations while a 503 preserves the original request', async () => {
  const store = ready(); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
  await expect(store.refresh('s1', 'epoch')).rejects.toThrow(); expect(() => store.prepare('s1', 'epoch', 'grant', 'test')).toThrow('刷新')
  store.stale[key] = false; store.prepare('s1', 'epoch', 'grant', 'test')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
  await expect(store.submit('s1', 'epoch')).rejects.toMatchObject({ status: 503 }); expect(store.pending[key]).toBeDefined()
})
