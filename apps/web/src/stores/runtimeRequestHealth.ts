import { defineStore } from 'pinia'
import { normalizeRuntimeHealthSnapshot, type RuntimeHealthSnapshot } from '@agent-cluster/shared'
import { apiGet, apiPost } from '@/api/client'

export const useRuntimeRequestHealthStore = defineStore('runtimeRequestHealth', {
  state: () => ({
    bySession: {} as Record<string, Record<string, RuntimeHealthSnapshot>>,
    queryErrors: {} as Record<string, string>,
    actionErrors: {} as Record<string, string>,
    waiting: {} as Record<string, boolean>,
    waitKeys: {} as Record<string, string>
  }),
  getters: {
    items: state => (sessionId: string) => Object.values(state.bySession[sessionId] ?? {})
  },
  actions: {
    merge(sessionId: string, value: unknown) {
      const next = normalizeRuntimeHealthSnapshot(value)
      if (!next || next.sessionId !== sessionId) return
      const items = this.bySession[sessionId] ??= {}
      const old = items[next.invocationId]
      // A same-version historical API projection must not be undone by pre-restart SSE replay.
      if (old && (next.sessionGeneration < old.sessionGeneration || next.version < old.version ||
        (old.historical && !next.historical && next.sessionGeneration === old.sessionGeneration && next.version === old.version) ||
        (old.stage === 'terminal' && next.stage !== 'terminal') ||
        (next.sessionGeneration === old.sessionGeneration && next.observerEpoch !== old.observerEpoch))) return
      items[next.invocationId] = next
    },
    async load(sessionId: string, signal?: AbortSignal) {
      try {
        const result = await apiGet<{ items: unknown[] }>(`/sessions/${encodeURIComponent(sessionId)}/runtime-health`, { signal, timeoutMs: 8000 })
        if (signal?.aborted) return
        for (const item of result.items ?? []) this.merge(sessionId, item)
        this.queryErrors[sessionId] = ''
      } catch {
        if (!signal?.aborted) this.queryErrors[sessionId] = '观测不可用；无法确认模型状态，原调用不会因此取消。'
      }
    },
    async wait(sessionId: string, item: RuntimeHealthSnapshot) {
      const key = `${sessionId}:${item.invocationId}`
      if (this.waiting[key]) return
      this.waiting[key] = true
      this.actionErrors[key] = ''
      // Retain key on network failure: manual retry is the same acknowledgement, never a model retry.
      const idempotencyKey = this.waitKeys[key] ??= crypto.randomUUID()
      try {
        const next = await apiPost<unknown>(`/sessions/${encodeURIComponent(sessionId)}/runtime-health/${encodeURIComponent(item.invocationId)}/wait`, {
          expectedVersion: item.version, sessionGeneration: item.sessionGeneration, idempotencyKey
        }, { timeoutMs: 8000 })
        this.merge(sessionId, next)
        delete this.waitKeys[key]
      } catch {
        this.actionErrors[key] = '等待确认未成功，请刷新状态后重试；没有重新请求模型。'
        await this.load(sessionId)
      } finally { this.waiting[key] = false }
    }
  }
})
