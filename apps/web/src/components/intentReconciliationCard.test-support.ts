import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Component } from 'vue'
import type { IntentReconciliationView } from '@agent-cluster/shared'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'

export function reconciliationView(): IntentReconciliationView {
  return {
    record: { id: 'case-1', sessionId: 'session-1', dataEpoch: 'epoch', sessionGeneration: 1,
      routingId: 'route', source: 'retry', sourceId: 'retry:checkpoint', revision: 2, evidenceHash: 'hash',
      status: 'open', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T01:00:00Z',
      binding: { failure: { runtimeType: 'codex' } } as any, decisions: [], attempts: [] },
    sessionRevision: 7, readOnly: false,
    evidence: { source: { collection: 'intentPlanStepsBySession', id: 'retry:checkpoint' },
      tasks: [{ id: 'task', status: 'failed', updatedAt: '2026-10-21T00:30:00Z', checkpoint: '未记录' }],
      invocations: [{ id: 'call', status: 'failed', candidate: '未记录' }], unownedWorkspaceChanges: null },
    actions: [{ action: 'redispatch', enabled: true }, { action: 'confirm_completed', enabled: false, reason: 'STOP_UNCONFIRMED' },
      { action: 'abandon', enabled: true }]
  }
}

export function intentReconciliationCardContract(Card: Component) {
  describe('R9b reconciliation confirmation', () => {
    const wrappers: ReturnType<typeof mount>[] = []
    afterEach(() => { wrappers.splice(0).forEach(row => row.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks() })
    function setup(view = reconciliationView(), pinia = createPinia()) {
      setActivePinia(pinia)
      const store = useSessionStore()
      vi.spyOn(store, 'assertBackendCompatible').mockResolvedValue(undefined)
      const wrapper = mount(Card, { props: { confirmation: {
        confirmationId: view.record.id, reconciliationCaseId: view.record.id, sessionId: view.record.sessionId,
        reason: 'intent_reconciliation_required', title: '执行结果需要人工对账', description: '核对已有证据',
        status: 'pending', options: [], intentReconciliation: view
      } }, global: { plugins: [pinia] } })
      wrappers.push(wrapper)
      return { wrapper, store, pinia }
    }
    function api(view = reconciliationView(), post?: (body: any) => Promise<Response>) {
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
        ? post ? post(JSON.parse(String(init.body))) : new Response(JSON.stringify({ data: { record: view.record, idempotentReplay: false } }), { status: 202 })
        : new Response(JSON.stringify({ data: [view] }), { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      return fetch
    }
    const button = (wrapper: ReturnType<typeof mount>, action: string) => wrapper.get(`[data-reconciliation-action="${action}"]`)

    it('shows unknown values, record provenance and observation time without inventing non-execution', async () => {
      api(); const { wrapper } = setup(); await flushPromises()
      expect(wrapper.text()).toContain('未知')
      expect(wrapper.text()).toContain('未记录不代表未执行')
      expect(wrapper.text()).toContain('tasks / task')
      expect(wrapper.text()).toContain('2026-10-21T00:30:00Z')
      expect(wrapper.text()).toContain('观测时间：未知')
      expect(wrapper.text()).toContain('未记录')
    })
    it('uses server availability and explains disabled actions', async () => {
      const fetch = api(); const { wrapper } = setup(); await flushPromises()
      expect(button(wrapper, 'confirm_completed').attributes('disabled')).toBeDefined()
      expect(wrapper.text()).toContain('STOP_UNCONFIRMED')
      await button(wrapper, 'confirm_completed').trigger('click')
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    })
    it('requires CLI responsibility, includes version and CAS and sends duplicate clicks once', async () => {
      let release!: (response: Response) => void
      const fetch = api(reconciliationView(), () => new Promise(resolve => { release = resolve }))
      const { wrapper } = setup(); await flushPromises()
      expect(wrapper.text()).toContain('当前新链路还不支持在该运行时上执行，选择后可能仍被阻止')
      expect(button(wrapper, 'redispatch').attributes('disabled')).toBeDefined()
      await wrapper.get('input[type="checkbox"]').setValue(true)
      await button(wrapper, 'redispatch').trigger('click')
      await button(wrapper, 'redispatch').trigger('click')
      await flushPromises()
      const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(JSON.parse(String(posts[0][1]!.body))).toMatchObject({ action: 'redispatch', expectedCaseRevision: 2,
        expectedSessionRevision: 7, acceptWorkspaceResponsibility: true, riskVersion: 'intent-cli-workspace-responsibility-v1' })
      expect(wrapper.findAll('[data-reconciliation-action]').every(row => row.attributes('disabled') !== undefined)).toBe(true)
      release(new Response(JSON.stringify({ data: { record: reconciliationView().record, idempotentReplay: false } }), { status: 202 }))
      await flushPromises()
    })
    it('keeps one idempotency key and payload after transport failure', async () => {
      const fetch = api(reconciliationView(), async () => { throw new TypeError('Failed to fetch') })
      const { wrapper } = setup(); await flushPromises()
      await button(wrapper, 'abandon').trigger('click'); await flushPromises()
      await button(wrapper, 'abandon').trigger('click'); await flushPromises()
      const bodies = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)))
      expect(bodies).toHaveLength(2)
      expect(bodies[0].idempotencyKey).toBeTruthy()
      expect(bodies[1]).toEqual(bodies[0])
    })
    it('shares the submission lock across two cards and omits CLI confirmation for abandon', async () => {
      let release!: (response: Response) => void
      const fetch = api(reconciliationView(), () => new Promise(resolve => { release = resolve }))
      const one = setup(), two = setup(reconciliationView(), one.pinia); await flushPromises()
      await one.wrapper.get('input[type="checkbox"]').setValue(true)
      await button(one.wrapper, 'abandon').trigger('click')
      await button(two.wrapper, 'abandon').trigger('click'); await flushPromises()
      const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(JSON.parse(String(posts[0][1]!.body))).not.toHaveProperty('acceptWorkspaceResponsibility')
      expect(JSON.parse(String(posts[0][1]!.body))).not.toHaveProperty('riskVersion')
      release(new Response(JSON.stringify({ data: { record: reconciliationView().record, idempotentReplay: false } }), { status: 202 }))
      await flushPromises()
    })
    it('requires a fresh CLI acknowledgement after evidence revision changes', async () => {
      const view = reconciliationView(); api(view)
      const { wrapper } = setup(); await flushPromises()
      await wrapper.get('input[type="checkbox"]').setValue(true)
      expect(button(wrapper, 'redispatch').attributes('disabled')).toBeUndefined()
      view.record.revision++
      await wrapper.findAll('button').find(row => row.text() === '刷新事实')!.trigger('click'); await flushPromises()
      expect(button(wrapper, 'redispatch').attributes('disabled')).toBeDefined()
      expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    })
    it('refuses malformed refresh data rather than submitting cached evidence', async () => {
      api(); const { wrapper } = setup(); await flushPromises()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ record: {} }] }), { status: 200 })))
      await wrapper.findAll('button').find(row => row.text() === '刷新事实')!.trigger('click'); await flushPromises()
      expect(wrapper.text()).toContain('对账事实格式无效')
      expect(wrapper.findAll('[data-reconciliation-action]').every(row => row.attributes('disabled') !== undefined)).toBe(true)
    })
    it('restores cases and historical decisions on a fresh store, even without event history', async () => {
      const view = reconciliationView(); view.record.status = 'resolved'
      view.record.decisions.push({ action: 'abandon', actorId: 'owner', decidedAt: '2026-10-21T02:00:00Z',
        idempotencyKey: 'old', payloadHash: 'old', evidenceHash: 'hash', expectedCaseRevision: 1, resultRevision: 2 })
      api(view)
      const { wrapper, store } = setup(view)
      await store.loadIntentReconciliations('session-1'); await flushPromises()
      const messages = useEventStore().chatMessages('session-1')
      expect(messages.filter(row => row.payload?.confirmationId === view.record.id)).toHaveLength(1)
      expect(wrapper.text()).toContain('放弃这个任务')
      expect(wrapper.text()).toContain('owner')
      expect(wrapper.text()).toContain('2026-10-21T02:00:00Z')
      expect(wrapper.findAll('[data-reconciliation-action]').every(row => row.attributes('disabled') !== undefined)).toBe(true)
    })
    it.each(['correction', 'isolated_test', 'plan_step'] as const)('shows %s as evidence and original handler only', async source => {
      const view = reconciliationView(); view.readOnly = true; view.record.source = source; view.handler = 'original-handler'
      api(view); const { wrapper } = setup(view); await flushPromises()
      expect(wrapper.findAll('[data-reconciliation-action]')).toHaveLength(0)
      expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('original-handler')
      expect(wrapper.text()).toContain('未知')
    })
    it('refreshes facts on 409 and never auto-posts a replacement decision', async () => {
      const view = reconciliationView()
      const fetch = api(view, async () => { view.record.revision = 3; view.actions[2] = { action: 'abandon', enabled: false, reason: 'NEW_FACTS' }
        return new Response(JSON.stringify({ error: { message: 'stale', code: 'STALE' } }), { status: 409 }) })
      const { wrapper } = setup(); await flushPromises()
      await button(wrapper, 'abandon').trigger('click'); await flushPromises()
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
      expect(fetch.mock.calls.filter(([, init]) => init?.method !== 'POST').length).toBeGreaterThanOrEqual(2)
      expect(wrapper.text()).toContain('NEW_FACTS')
      expect(button(wrapper, 'abandon').attributes('disabled')).toBeDefined()
    })
    it('blocks stale actions and reports refresh failure following a 409', async () => {
      let conflict = false
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') { conflict = true; return new Response(JSON.stringify({ error: { code: 'STALE' } }), { status: 409 }) }
        if (conflict) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ data: [reconciliationView()] }), { status: 200 })
      })
      vi.stubGlobal('fetch', fetch)
      const { wrapper } = setup(); await flushPromises()
      await button(wrapper, 'abandon').trigger('click'); await flushPromises()
      expect(wrapper.text()).toContain('已请求刷新')
      expect(wrapper.text()).not.toContain('已重新读取')
      expect(wrapper.findAll('[data-reconciliation-action]').every(row => row.attributes('disabled') !== undefined)).toBe(true)
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    })
    it('projects fresh facts once over repeated persisted confirmation events', async () => {
      const view = reconciliationView(); api(view); const { store } = setup(); await flushPromises()
      const events = useEventStore()
      const event: any = { sessionId: 'session-1', type: 'user_confirmation_requested', actor: { type: 'system', id: 'system' },
        toAgentIds: [], createdAt: view.record.createdAt, content: '核对', metadata: { schemaVersion: '0.1', payload: {
          reason: 'intent_reconciliation_required', confirmationId: view.record.id, caseId: view.record.id, status: 'pending' } } }
      events.commitServerEvents('session-1', [{ ...event, id: 'event-1' }, { ...event, id: 'event-2' }])
      await flushPromises()
      expect(events.chatMessages('session-1').filter(row => row.payload?.confirmationId === view.record.id)).toHaveLength(1)
      expect(events.activeConfirmation('session-1')?.intentReconciliation?.record.id).toBe(view.record.id)
      view.record.status = 'resolved'; await store.loadIntentReconciliations('session-1'); await flushPromises()
      expect(events.activeConfirmation('session-1')).toBeUndefined()
      expect(events.chatMessages('session-1').find(row => row.payload?.confirmationId === view.record.id)?.payload?.status).toBe('approved')
    })
  })
}
