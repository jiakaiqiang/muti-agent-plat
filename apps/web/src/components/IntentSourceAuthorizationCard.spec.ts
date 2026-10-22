import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IntentSourceAuthorizationCard from './IntentSourceAuthorizationCard.vue'
import type { ConfirmationCardState } from '@/types/contracts'
import { useSessionStore } from '@/stores/session'
import { ApiRequestError } from '@/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('intent source authorization card', () => {
  it('loads server candidates, leaves suggestions unchecked, and submits candidateRefs only', async () => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/health')) return new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', status: 'ok' } }), { status: 200 })
      if (init?.method === 'POST') return new Response(JSON.stringify({ data: { request: { status: 'approved' } } }), { status: 202 })
      if (path.includes('/candidates')) return new Response(JSON.stringify({ data: { candidates: [
        { ref: 'intent-source-candidate-ref:one', path: 'src/login.ts', size: 12, hash: 'a'.repeat(64), suggested: true, expiresAt: '2099-01-01T00:00:00.000Z' },
        { ref: 'intent-source-candidate-ref:two', path: 'src/second.ts', size: 14, hash: 'b'.repeat(64), suggested: false, expiresAt: '2099-01-01T00:00:00.000Z' }
      ], total: 2, truncated: false } }), { status: 200 })
      return new Response(JSON.stringify({ data: { id: 'session-1', updatedAt: '2099-01-01T00:00:00.000Z' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSessionStore()
    const decide = vi.spyOn(store, 'decideIntentSourceAuthorization').mockResolvedValue(undefined)
    const confirmation: ConfirmationCardState = {
      confirmationId: 'request-1', sessionId: 'session-1', reason: 'intent_source_authorization',
      title: '选择源码范围', description: '请确认可修改的文件。', status: 'pending', options: [],
      requestRevision: 2, sessionRevision: 7,
      sourceAuthorization: { sourceEventId: 'source-event', workItemId: 'work-1', candidateRefs: [], prohibitions: [] }
    }
    const wrapper = mount(IntentSourceAuthorizationCard, { props: { confirmation }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.text()).toContain('建议（仍需手动勾选）')
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    await wrapper.find('input[type="checkbox"]').setValue(true)
    expect(wrapper.text()).toContain('已选 1 个文件')
    const approve = wrapper.findAll('button').find(button => button.text().includes('批准所选清单'))
    expect(approve).toBeTruthy()
    await approve!.trigger('click')
    await flushPromises()
    expect(decide).toHaveBeenCalledTimes(1)
    const body = decide.mock.calls[0][2]
    expect(body).toMatchObject({ action: 'approve', expectedRequestRevision: 2, expectedSessionRevision: 7, candidateRefs: ['intent-source-candidate-ref:one'] })
    expect(body).not.toHaveProperty('paths')
    expect(body.prohibitions).toEqual(['no_schema_change'])
  })

  it('shows incomplete-result guidance and refreshes after a stale 409 without retrying the decision', async () => {
    let candidateLoads = 0
    const fetch = vi.fn(async (url: unknown) => {
      const path = String(url)
      if (path.includes('/candidates')) {
        candidateLoads++
        return new Response(JSON.stringify({ data: { candidates: [{ ref: 'ref-one', path: 'src/needle.ts', size: 1, hash: 'a'.repeat(64), suggested: false, expiresAt: '2099-01-01T00:00:00.000Z' }], total: 1, truncated: true, truncatedReason: 'entry_scan_budget_exhausted' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', status: 'ok' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia(); setActivePinia(pinia)
    const store = useSessionStore()
    const decide = vi.spyOn(store, 'decideIntentSourceAuthorization').mockRejectedValue(new ApiRequestError('stale', 409, 'INTENT_SOURCE_CANDIDATE_STALE'))
    const confirmation: ConfirmationCardState = {
      confirmationId: 'request-2', sessionId: 'session-1', reason: 'intent_source_authorization', title: '选择源码范围', description: '', status: 'pending', options: [], requestRevision: 1, sessionRevision: 1,
      sourceAuthorization: { sourceEventId: 'source-event', workItemId: 'work-1', candidateRefs: [], prohibitions: [] }
    }
    const wrapper = mount(IntentSourceAuthorizationCard, { props: { confirmation }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.text()).toContain('结果不完整，请输入更具体的路径后搜索')
    await wrapper.find('input[type="checkbox"]').setValue(true)
    const approve = wrapper.findAll('button').find(button => button.text().includes('批准所选清单'))!
    await approve.trigger('click'); await flushPromises()
    expect(decide).toHaveBeenCalledTimes(1)
    expect(candidateLoads).toBeGreaterThanOrEqual(2)
    expect(wrapper.text()).toContain('候选文件已过期或事实已变化，请重新加载并重新选择')
  })

  it('restores the server-backed decision and selection after remount', async () => {
    const fetch = vi.fn(async (url: unknown) => {
      const path = String(url)
      if (path.includes('/candidates')) {
        return new Response(JSON.stringify({ data: { candidates: [
          { ref: 'ref-restored', path: 'src/restored.ts', size: 9, hash: 'c'.repeat(64), suggested: true, expiresAt: '2099-01-01T00:00:00.000Z' }
        ], total: 1, truncated: false } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', status: 'ok' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia(); setActivePinia(pinia)
    const confirmation: ConfirmationCardState = {
      confirmationId: 'request-restored', sessionId: 'session-1', reason: 'intent_source_authorization',
      title: '选择源码范围', description: '', status: 'pending', options: [], requestRevision: 3, sessionRevision: 8,
      sourceAuthorization: { sourceEventId: 'source-event', workItemId: 'work-1', candidateRefs: ['ref-restored'], prohibitions: ['no_schema_change'] }
    }

    const first = mount(IntentSourceAuthorizationCard, { props: { confirmation }, global: { plugins: [pinia] } })
    await flushPromises()
    expect((first.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect(first.text()).toContain('已选 1 个文件')
    first.unmount()

    const refreshed = mount(IntentSourceAuthorizationCard, { props: { confirmation }, global: { plugins: [pinia] } })
    await flushPromises()
    expect((refreshed.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect(refreshed.text()).toContain('已选 1 个文件')
    expect(refreshed.text()).toContain('src/restored.ts')
  })

  it('submits only once when approval is clicked repeatedly while the first request is pending', async () => {
    let resolveDecision!: () => void
    const fetch = vi.fn(async (url: unknown) => {
      const path = String(url)
      if (path.includes('/candidates')) {
        return new Response(JSON.stringify({ data: { candidates: [
          { ref: 'ref-once', path: 'src/once.ts', size: 4, hash: 'd'.repeat(64), suggested: false, expiresAt: '2099-01-01T00:00:00.000Z' }
        ], total: 1, truncated: false } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, commit: 'test', status: 'ok' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia(); setActivePinia(pinia)
    const store = useSessionStore()
    const decide = vi.spyOn(store, 'decideIntentSourceAuthorization').mockImplementation(() => new Promise<void>(resolve => { resolveDecision = resolve }))
    const confirmation: ConfirmationCardState = {
      confirmationId: 'request-once', sessionId: 'session-1', reason: 'intent_source_authorization',
      title: '选择源码范围', description: '', status: 'pending', options: [], requestRevision: 1, sessionRevision: 1,
      sourceAuthorization: { sourceEventId: 'source-event', workItemId: 'work-1', candidateRefs: [], prohibitions: [] }
    }
    const wrapper = mount(IntentSourceAuthorizationCard, { props: { confirmation }, global: { plugins: [pinia] } })
    await flushPromises()
    await wrapper.find('input[type="checkbox"]').setValue(true)
    const approve = wrapper.findAll('button').find(button => button.text().includes('批准所选清单'))!
    const firstClick = approve.trigger('click')
    const secondClick = approve.trigger('click')
    await Promise.all([firstClick, secondClick])
    expect(decide).toHaveBeenCalledTimes(1)
    resolveDecision()
    await flushPromises()
  })
})
