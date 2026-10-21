import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { IntentTestAuthorityView, IntentTestScript, SessionDetail } from '@agent-cluster/shared'
import IntentTestAuthorityPanel from './IntentTestAuthorityPanel.vue'
import { useEventStore } from '@/stores/event'

const session = (id = 's1') => ({ id, dataEpoch: 'epoch', revision: 1, workingDirectory: { name: 'sample-project' } } as SessionDetail)
function view(revision = 1, script: IntentTestScript | null = null, revoked = false, id = 's1'): IntentTestAuthorityView {
  const availableBindings = (['test', 'test:unit'] as const).map((script, index) => ({ runnerId: 'docker-npm-tests-v1' as const,
    resourceId: `test-runner:${String(index + 1).repeat(64)}`, bindingHash: String(index + 1).repeat(64), workspaceBindingHash: 'a'.repeat(64),
    workspaceId: 'workspace', imageId: `sha256:${'b'.repeat(64)}`, script }))
  const binding = availableBindings.find(row => row.script === script)
  return { sessionId: id, dataEpoch: 'epoch', sessionRevision: revision, availableBindings, enabled: Boolean(binding && !revoked),
    authority: binding ? { binding, grant: { id: `isolated-test:${id}:${binding.bindingHash}`, effect: 'run_tests',
      resource: { kind: 'test_runner', refId: binding.resourceId }, revision, sourceEventId: 'event', ...(revoked ? { revokedAt: 'now' } : {}) } } : null }
}
const response = (data: unknown) => new Response(JSON.stringify({ data }))
let wrapper: VueWrapper | undefined
const button = (text: string) => wrapper!.findAll('button').find(row => row.text() === text)!
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('labels the script selector, grants the explicit selection and explains that authorization does not start tests', async () => {
  let current = view(); const requests: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); requests.push(body); current = view(current.sessionRevision + 1, body.script, body.action === 'revoke') }
    return response(current)
  }))
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } }); await flushPromises()
  expect(wrapper.attributes('aria-label')).toBe('隔离测试授权'); expect(wrapper.get('select').element.closest('label')?.textContent).toContain('测试脚本')
  expect(wrapper.text()).toContain('旧请求不会自动重跑'); expect(requests).toHaveLength(0)
  await wrapper.get('select').setValue('test:unit'); await button('允许所选测试').trigger('click'); await flushPromises()
  expect(requests[0]).toMatchObject({ script: 'test:unit', action: 'grant', expectedGrantRevision: 0 })
  expect(wrapper.text()).toContain('已允许 test:unit'); expect(wrapper.text()).toContain('旧测试请求不会自动重新执行')
  await button('撤销测试授权').trigger('click'); await flushPromises()
  expect(requests[1]).toMatchObject({ script: 'test:unit', action: 'revoke', expectedGrantRevision: 2 })
  expect(wrapper.text()).toContain('已撤销测试授权')
})

it('unknown outcome survives remount and reload with the original script and idempotency key', async () => {
  const posts: string[] = []; let fail = true
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(init.body); if (fail) throw new TypeError('network'); return response(view(2, 'test:unit')) }
    return response(view())
  }))
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } }); await flushPromises()
  await wrapper.get('select').setValue('test:unit'); await wrapper.get('input[type="checkbox"]').setValue(true)
  await button('允许所选测试').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('尚未确认'); expect(wrapper.get('select').attributes('disabled')).toBeDefined()
  wrapper.unmount(); setActivePinia(createPinia())
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } }); await flushPromises()
  expect(wrapper.text()).toContain('test:unit 的授权结果尚未确认')
  expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
  fail = false; await button('重试原测试授权请求').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1]); expect(JSON.parse(posts[0]).writeReport).toBe(true)
  expect(wrapper.text()).toContain('已允许 test:unit')
})

it('a conflict requires another user action and authority events refresh the current state', async () => {
  let current = view(), posts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts++; current = view(3, 'test:unit'); return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 }) }
    return response(current)
  }))
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } }); await flushPromises()
  await button('允许所选测试').trigger('click'); await flushPromises()
  expect(posts).toBe(1); expect(wrapper.get('[role="alert"]').text()).toContain('状态已发生变化')
  expect(wrapper.text()).toContain('已允许 test:unit')
  current = view(4, 'test:unit', true); useEventStore().eventsBySessionId.s1 = [{ id: 'revoke', type: 'intent_test_authority_changed' }] as any
  await flushPromises(); expect(wrapper.text()).toContain('已撤销测试授权'); expect(posts).toBe(1)
})

it('late replies from another session do not show success or error in the active panel', async () => {
  let release!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/s1/') ? new Promise<Response>(done => { release = done }) : response(view(3, null, false, 's2'))))
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } })
  await wrapper.setProps({ session: session('s2') }); await flushPromises()
  release(response(view(2, 'test:unit'))); await flushPromises()
  expect(wrapper.text()).toContain('尚未授权测试'); expect(wrapper.text()).not.toContain('已允许 test:unit')
  await wrapper.setProps({ disabled: true }); expect(button('允许所选测试').attributes('disabled')).toBeDefined()
})

it('missing configuration has no grant action but a prior authorization can still be revoked', async () => {
  let current = { ...view(), availableBindings: [] }
  vi.stubGlobal('fetch', vi.fn(async () => response(current)))
  wrapper = mount(IntentTestAuthorityPanel, { props: { session: session() } }); await flushPromises()
  expect(wrapper.text()).toContain('隔离测试环境尚未配置'); expect(button('允许所选测试')).toBeUndefined()
  current = { ...view(2, 'test:unit'), enabled: false, availableBindings: [] }
  await button('刷新测试状态').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('原测试授权已失效'); expect(button('撤销测试授权')).toBeDefined()
})
