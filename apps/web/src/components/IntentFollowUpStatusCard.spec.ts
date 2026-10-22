import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IntentFollowUpStatusCard from './IntentFollowUpStatusCard.vue'
import { useSessionStore } from '@/stores/session'
import type { SessionDetail } from '@agent-cluster/shared'
import { ApiRequestError } from '@/api/client'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('intent follow-up status card', () => {
  it('shows blocked reasons and exposes cancellation only for queued and brief follow-ups', async () => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => String(url).endsWith('/health')
      ? new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', buildId: 'test-build', status: 'ok' } }), { status: 200 })
      : init?.method === 'POST'
        ? new Response(JSON.stringify({ data: { status: 'cancelled', revision: 3 } }), { status: 202 })
        : new Response(JSON.stringify({ data: { id: 'session-1', updatedAt: '2099-01-01T00:00:00.000Z' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia(); setActivePinia(pinia)
    const store = useSessionStore(); vi.spyOn(store, 'refreshSessionCache').mockResolvedValue(undefined as never)
    const session = { id: 'session-1', intentFollowUps: [
      { id: 'queued-1', status: 'queued', revision: 2, content: '补充登录页', failureCode: undefined },
      { id: 'blocked-1', status: 'blocked', revision: 3, content: '补充接口', failureCode: 'INTENT_FOLLOW_UP_BASELINE_CHANGED' },
      { id: 'cancelled-1', status: 'cancelled', revision: 4, content: '旧补充', failureCode: undefined }
    ] } as unknown as SessionDetail
    const wrapper = mount(IntentFollowUpStatusCard, { props: { session }, global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('INTENT_FOLLOW_UP_BASELINE_CHANGED')
    expect(wrapper.findAll('button').filter(button => button.text().includes('取消这条追加需求'))).toHaveLength(1)
    await wrapper.get('button').trigger('click'); await flushPromises()
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ expectedRevision: 2, idempotencyKey: 'cancel:queued-1:2' })
    expect(wrapper.text()).toContain('已取消')
  })

  it('refreshes on a revision conflict and does not retry cancellation', async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith('/health')
      ? new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', buildId: 'test-build', status: 'ok' } }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 'INTENT_FOLLOW_UP_REVISION_CONFLICT', message: '版本已变化' } }), { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia(); setActivePinia(pinia)
    const store = useSessionStore()
    const refresh = vi.spyOn(store, 'refreshSessionCache').mockResolvedValue(undefined as never)
    const session = { id: 'session-2', intentFollowUps: [{ id: 'queued-2', status: 'queued', revision: 1, sourceEventId: 'event-2' }] } as unknown as SessionDetail
    const wrapper = mount(IntentFollowUpStatusCard, { props: { session }, global: { plugins: [pinia] } })
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(refresh).toHaveBeenCalled()
    expect(wrapper.text()).toContain('版本已变化')
  })
})
