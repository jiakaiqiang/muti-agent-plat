import { defineStore } from 'pinia'
import { isConfirmIntentBriefInput, type ConfirmIntentBriefInput, type IntentBriefConfirmationReceipt } from '@agent-cluster/shared'
import { apiPost, ApiRequestError } from '@/api/client'

const keyFor = (sessionId: string, briefId: string) => JSON.stringify([sessionId, briefId])
const storageKey = (key: string) => `agent-cluster.intent-brief-confirm:${key}`
type Result = { accepted: true; sessionId: string; briefId: string; dataEpoch: string; status: 'PAUSED' | 'WAIT_WORKFLOW_SELECT'; receipt: IntentBriefConfirmationReceipt; idempotentReplay: boolean }
const sameBinding = (a: ConfirmIntentBriefInput, b: ConfirmIntentBriefInput) =>
  a.contractVersion === b.contractVersion && a.dataEpoch === b.dataEpoch && a.confirmationId === b.confirmationId &&
  a.expectedBriefVersion === b.expectedBriefVersion && a.expectedIntentRevision === b.expectedIntentRevision

/** Shared by Web/Desktop. An uncertain POST keeps its original identity across a renderer reload. */
export const useIntentBriefConfirmationStore = defineStore('intentBriefConfirmation', {
  state: () => ({ pending: {} as Record<string, ConfirmIntentBriefInput>, busy: {} as Record<string, boolean> }),
  actions: {
    async confirm(sessionId: string, briefId: string, binding: Omit<ConfirmIntentBriefInput, 'contractVersion' | 'idempotencyKey'>) {
      const key = keyFor(sessionId, briefId)
      if (this.busy[key]) throw new Error('草稿确认正在提交。')
      const proposed: ConfirmIntentBriefInput = { ...binding, contractVersion: 'intent-brief-confirm-v1', idempotencyKey: crypto.randomUUID() }
      if (!isConfirmIntentBriefInput(proposed)) throw new Error('草稿确认信息不完整，请刷新原确认卡。')
      if (!this.pending[key]) {
        try {
          const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(key)) ?? 'null')
          if (isConfirmIntentBriefInput(saved)) this.pending[key] = saved
        } catch { /* Storage may be unavailable; in-memory retry remains bound. */ }
      }
      const pending = this.pending[key]
      if (pending && !sameBinding(pending, proposed)) throw new Error('上一次确认结果尚未核实，请返回原草稿重试。')
      const request = { ...(pending ?? proposed) }
      this.pending[key] = request
      try { sessionStorage.setItem(storageKey(key), JSON.stringify(request)) } catch { /* Memory fallback. */ }
      this.busy[key] = true
      const clear = () => {
        delete this.pending[key]
        try { sessionStorage.removeItem(storageKey(key)) } catch { /* Memory fallback. */ }
      }
      try {
        const result = await apiPost<Result>(`/sessions/${encodeURIComponent(sessionId)}/briefs/${encodeURIComponent(briefId)}/confirm`, request,
          { timeoutMs: 20_000, timeoutMessage: '确认结果尚未核实，请重试原草稿确认。' })
        if (!result || result.accepted !== true || result.sessionId !== sessionId || result.briefId !== briefId || result.dataEpoch !== request.dataEpoch ||
          !result.receipt?.id || !isConfirmIntentBriefInput(result.receipt.request) || !sameBinding(result.receipt.request, request) ||
          !['PAUSED', 'WAIT_WORKFLOW_SELECT'].includes(result.status) || result.receipt.resultStatus !== result.status ||
          typeof result.idempotentReplay !== 'boolean' || (!result.idempotentReplay && result.receipt.request.idempotencyKey !== request.idempotencyKey)) {
          throw new Error('确认回执与原草稿不匹配，请重试原请求核实结果。')
        }
        clear()
        return result
      } catch (error) {
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) clear()
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
