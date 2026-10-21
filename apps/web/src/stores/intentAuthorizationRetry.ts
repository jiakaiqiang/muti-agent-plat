import { defineStore } from 'pinia'
import { canRetryIntentAuthorization, type IntentRoutingRecord, type RetryIntentAuthorizationInput } from '@agent-cluster/shared'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'

export type AuthorizationRetryReference = { sessionId: string; routingId: string; dataEpoch: string; sourceEventId: string }
export const authorizationRetryKey = (ref: AuthorizationRetryReference) => JSON.stringify([ref.sessionId, ref.dataEpoch, ref.routingId, ref.sourceEventId])
const path = (ref: AuthorizationRetryReference) => `/sessions/${encodeURIComponent(ref.sessionId)}/message-routings/${encodeURIComponent(ref.routingId)}`
const storageKey = (key: string) => `intent-authorization-retry:v1:${key}`
function save(key: string, payload?: RetryIntentAuthorizationInput) {
  try { if (payload) sessionStorage.setItem(storageKey(key), JSON.stringify(payload)); else sessionStorage.removeItem(storageKey(key)) } catch { /* keep in-memory retry */ }
}
function normalize(value: unknown, ref: AuthorizationRetryReference): IntentRoutingRecord {
  const row = value as IntentRoutingRecord
  if (!row || row.id !== ref.routingId || row.sessionId !== ref.sessionId || row.sourceEventId !== ref.sourceEventId ||
    row.semanticProposal?.dataEpoch !== ref.dataEpoch || !Number.isSafeInteger(row.routingRevision) || row.routingRevision! < 1 ||
    !row.semanticPlan || !Array.isArray(row.semanticPlan.validation?.errorCodes)) throw new Error('原请求状态不匹配，请刷新会话。')
  return row
}
export const useIntentAuthorizationRetryStore = defineStore('intentAuthorizationRetry', {
  state: () => ({ routes: {} as Record<string, IntentRoutingRecord>, pending: {} as Record<string, RetryIntentAuthorizationInput>,
    busy: {} as Record<string, boolean>, stale: {} as Record<string, boolean>, reads: {} as Record<string, number> }),
  actions: {
    restore(ref: AuthorizationRetryReference) {
      const key = authorizationRetryKey(ref); if (this.pending[key]) return
      try {
        const raw = sessionStorage.getItem(storageKey(key)); if (!raw) return
        const value = JSON.parse(raw) as RetryIntentAuthorizationInput
        if (!value || value.contractVersion !== 'intent-authorization-retry-v1' || value.dataEpoch !== ref.dataEpoch ||
          !Number.isSafeInteger(value.expectedRoutingRevision) || value.expectedRoutingRevision < 1 ||
          typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim() || value.idempotencyKey.length > 256 ||
          Object.keys(value).some(name => !['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'].includes(name))) { save(key); return }
        this.pending[key] = value
      } catch { save(key) }
    },
    record(ref: AuthorizationRetryReference, value: unknown) {
      const route = normalize(value, ref), key = authorizationRetryKey(ref)
      if (!this.routes[key] || route.routingRevision! >= this.routes[key].routingRevision!) this.routes[key] = route
    },
    async refresh(ref: AuthorizationRetryReference, signal?: AbortSignal) {
      this.restore(ref); const key = authorizationRetryKey(ref), read = (this.reads[key] ?? 0) + 1
      this.reads[key] = read; this.stale[key] = true
      const route = await apiGet<unknown>(path(ref), { signal })
      if (!signal?.aborted && this.reads[key] === read) { this.record(ref, route); this.stale[key] = false }
    },
    prepare(ref: AuthorizationRetryReference) {
      this.restore(ref); const key = authorizationRetryKey(ref), route = this.routes[key]
      if (this.busy[key] || this.pending[key]) throw new Error('请先核对原提交结果。')
      if (this.stale[key] || !route || !canRetryIntentAuthorization(route)) throw new Error('当前请求不能重新校验，请刷新状态。')
      this.pending[key] = { contractVersion: 'intent-authorization-retry-v1', dataEpoch: ref.dataEpoch,
        expectedRoutingRevision: route.routingRevision!, idempotencyKey: crypto.randomUUID() }
      save(key, this.pending[key])
    },
    async submit(ref: AuthorizationRetryReference) {
      const key = authorizationRetryKey(ref), payload = this.pending[key]
      if (!payload || this.busy[key]) throw new Error('没有待核对的原提交，或请求正在处理。')
      this.busy[key] = true; this.reads[key] = (this.reads[key] ?? 0) + 1
      try {
        const result = await apiPost<{ routing: unknown }>(`${path(ref)}/retry-authorization`, { ...payload },
          { timeoutMs: 20_000, timeoutMessage: '提交结果尚未确认，请核对原提交结果。' })
        const routing = normalize(result.routing, ref)
        const receipt = routing.authorizationRetryReceipts?.find(row => row.request?.idempotencyKey === payload.idempotencyKey)
        if (!receipt || !(['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'] as const).every(field => receipt.request[field] === payload[field]) ||
          !Number.isSafeInteger(receipt.intentRevision) || receipt.intentRevision < 1 || !Number.isSafeInteger(receipt.resultRoutingRevision) ||
          receipt.resultRoutingRevision <= payload.expectedRoutingRevision || receipt.resultRoutingRevision > routing.routingRevision!) {
          throw new Error('原提交回执不匹配，请核对原提交结果。')
        }
        this.record(ref, result.routing); this.stale[key] = false
        delete this.pending[key]; save(key)
      } catch (error) {
        this.stale[key] = true
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          delete this.pending[key]; save(key)
          if ([409, 410].includes(error.status)) await this.refresh(ref).catch(() => undefined)
        }
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
