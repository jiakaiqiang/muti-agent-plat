import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import IntentReconciliationCard from './IntentReconciliationCard.vue'
import type { IntentReconciliationView } from '@agent-cluster/shared'

const genericView = (): IntentReconciliationView => ({
  record: { id: 'case-source', sessionId: 'session-1', dataEpoch: 'epoch', sessionGeneration: 1, routingId: '', source: 'source_writeback', sourceId: 'source-writeback:claim-1', revision: 1, evidenceHash: 'generic-hash', status: 'open', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', decisions: [], attempts: [] },
  sessionRevision: 3, readOnly: true, evidence: { source: { id: 'source-writeback:claim-1' } }, actions: []
})
const sourceView = { id: 'source-writeback:claim-1', source: 'source_writeback' as const, claim: { id: 'claim-1', candidateId: 'candidate-1' }, authorityId: 'authority-1', candidateId: 'candidate-1', evidence: { evidenceHash: 'source-hash', note: '当前文件哈希', files: [{ path: 'src/login.ts', baseHash: 'base', targetHash: 'target', currentHash: 'current' }] }, actions: [
  { action: 'redispatch' as const, enabled: false, reason: '当前文件哈希与写回基线不一致，无法安全重新派发。' }, { action: 'confirm_completed' as const, enabled: false, reason: '当前文件哈希未达到候选目标，无法确认已完成。' }, { action: 'abandon' as const, enabled: true }
] }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('source writeback reconciliation card', () => {
  it('loads source-writeback facts and exposes all three server actions', async () => {
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST') return new Response(JSON.stringify({ data: {} }), { status: 202 })
      if (path.includes('/intent-source-reconciliations')) return new Response(JSON.stringify({ data: [sourceView] }), { status: 200 })
      return new Response(JSON.stringify({ data: [genericView()] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia()
    const wrapper = mount(IntentReconciliationCard, { props: { confirmation: { confirmationId: 'case-source', reconciliationCaseId: 'case-source', sessionId: 'session-1', reason: 'intent_reconciliation_required', title: '写回需要核对', description: '核对源码写回事实', status: 'pending', options: [], intentReconciliation: genericView() } }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.findAll('[data-reconciliation-action]')).toHaveLength(3)
    const buttons = wrapper.findAll('[data-reconciliation-action]')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeDefined()
    expect(buttons[2].attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('当前文件哈希与写回基线不一致')
    expect(wrapper.text()).toContain('当前文件哈希未达到候选目标')
    expect(wrapper.text()).toContain('src/login.ts')
  })
})
