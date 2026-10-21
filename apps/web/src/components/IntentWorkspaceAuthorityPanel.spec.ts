import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionDetail } from '@agent-cluster/shared'
import IntentWorkspaceAuthorityPanel from './IntentWorkspaceAuthorityPanel.vue'
import { authorityKey, useIntentWorkspaceAuthorityStore } from '@/stores/intentWorkspaceAuthority'
import { useEventStore } from '@/stores/event'

const session = (id = 's1') => ({ id, dataEpoch: 'epoch', revision: 1,
  workingDirectory: { name: 'sample-repo' }, intentContractVersion: 'intent-understanding-v1' } as SessionDetail)
const view = (id = 's1', revision = 1, enabled = true) => ({ sessionId: id, dataEpoch: 'epoch', sessionRevision: revision,
  bindingHash: 'binding', enabled, authority: { bindingHash: 'binding', grant: { id: 'grant', effect: 'read_workspace',
    resource: { kind: 'workspace', refId: 'workspace' }, revision, sourceEventId: 'source',
    ...(!enabled ? { revokedAt: '2026-10-19T00:00:00Z' } : {}) } } })
const response = (data: unknown) => new Response(JSON.stringify({ data }))
let wrapper: VueWrapper | undefined
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })
const button = (text: string) => wrapper!.findAll('button').find(row => row.text() === text)!

it('shows granted state and a named action, then grants again only after an explicit click', async () => {
  const requests: unknown[] = []; let current = view()
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); requests.push(body); current = view('s1', current.sessionRevision + 1, body.action === 'grant') }
    return response(current)
  }))
  wrapper = mount(IntentWorkspaceAuthorityPanel, { props: { session: session() } }); await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe('已允许读取')
  expect(wrapper.attributes('aria-label')).toBe('工作区读取授权')
  await button('撤销读取授权').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('已撤销读取'); expect(requests).toHaveLength(1)
  await button('允许读取工作区').trigger('click'); await flushPromises()
  expect(requests[1]).toMatchObject({ action: 'grant', expectedGrantRevision: 2 })
  expect(wrapper.text()).toContain('重新发送需要读取文件的消息')
})

it('an unknown POST outcome stays retryable after leaving and returning to the session', async () => {
  const posts: string[] = []; let fail = true
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') { posts.push(init.body); if (fail) throw new TypeError('Failed to fetch'); return response(view('s1', 2, false)) }
    return response(view(String(url).includes('/s2/') ? 's2' : 's1'))
  }))
  wrapper = mount(IntentWorkspaceAuthorityPanel, { props: { session: session() } }); await flushPromises()
  await button('撤销读取授权').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('尚未确认')
  await wrapper.setProps({ session: session('s2') }); await flushPromises()
  expect(wrapper.text()).not.toContain('重试原请求')
  await wrapper.setProps({ session: session() }); await flushPromises()
  fail = false; await button('重试原请求').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1])
})

it('late response from another session cannot change the visible state', async () => {
  let release!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/s1/') ? new Promise<Response>(done => { release = done }) : response(view('s2', 3, false))))
  wrapper = mount(IntentWorkspaceAuthorityPanel, { props: { session: session() } })
  await wrapper.setProps({ session: session('s2') }); await flushPromises()
  release(response(view('s1'))); await flushPromises()
  expect(wrapper.text()).toContain('已撤销读取')
  expect(useIntentWorkspaceAuthorityStore().views[authorityKey('s1', 'epoch')]).toBeUndefined()
})

it('an authority event refreshes the shared panel and offline mode disables mutation', async () => {
  let current = view(); const fetcher = vi.fn(async () => response(current)); vi.stubGlobal('fetch', fetcher)
  wrapper = mount(IntentWorkspaceAuthorityPanel, { props: { session: session() } }); await flushPromises()
  current = view('s1', 2, false)
  useEventStore().eventsBySessionId.s1 = [{ id: 'revoke', type: 'intent_workspace_authority_changed' }] as any
  await flushPromises(); expect(wrapper.text()).toContain('已撤销读取'); expect(fetcher).toHaveBeenCalledTimes(2)
  await wrapper.setProps({ disabled: true })
  expect(button('允许读取工作区').attributes('disabled')).toBeDefined()
})

it('unavailable workspace has an explanation and no grant button', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...view(), enabled: false, bindingHash: null, authority: null })))
  wrapper = mount(IntentWorkspaceAuthorityPanel, { props: { session: session() } }); await flushPromises()
  expect(wrapper.text()).toContain('工作区尚不可读取'); expect(button('允许读取工作区')).toBeUndefined()
})
