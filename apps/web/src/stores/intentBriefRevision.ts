import { defineStore } from 'pinia'
import { isReviseIntentBriefInput, type ReviseIntentBriefInput } from '@agent-cluster/shared'
import { apiPost, ApiRequestError } from '@/api/client'

type Result = { accepted: true; sessionId: string; briefId: string; dataEpoch: string; routingId: string; status: string;
  request: ReviseIntentBriefInput; idempotentReplay: boolean }
const same = (a: ReviseIntentBriefInput, b: ReviseIntentBriefInput) => a.dataEpoch === b.dataEpoch && a.confirmationId === b.confirmationId &&
  a.expectedBriefVersion === b.expectedBriefVersion && a.expectedIntentRevision === b.expectedIntentRevision &&
  a.userMessage === b.userMessage && JSON.stringify(a.questionAnswers) === JSON.stringify(b.questionAnswers) &&
  JSON.stringify(a.assignedAgentKeys ?? []) === JSON.stringify(b.assignedAgentKeys ?? [])

export const useIntentBriefRevisionStore = defineStore('intentBriefRevision', {
  state: () => ({ pending: {} as Record<string, ReviseIntentBriefInput>, busy: {} as Record<string, boolean> }),
  actions: {
    async submit(sessionId: string, briefId: string, input: Omit<ReviseIntentBriefInput, 'contractVersion' | 'idempotencyKey'>) {
      const key = JSON.stringify([sessionId, briefId]), storageKey = `agent-cluster.intent-brief-revise:${key}`
      if (this.busy[key]) throw new Error('草稿修订正在提交。')
      const proposed: ReviseIntentBriefInput = { ...input, contractVersion: 'intent-brief-revise-v1', idempotencyKey: crypto.randomUUID() }
      if (!isReviseIntentBriefInput(proposed)) throw new Error('请填写修改说明和有效回答，总长度不得超过 8000 字。')
      if (!this.pending[key]) {
        try { const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); if (isReviseIntentBriefInput(saved)) this.pending[key] = saved }
        catch { /* In-memory retry remains available when storage is disabled. */ }
      }
      const old = this.pending[key]
      if (old && !same(old, proposed)) throw new Error('上一次修订结果尚未核实，请保持原修改内容重试。')
      const request = JSON.parse(JSON.stringify(old ?? proposed)) as ReviseIntentBriefInput
      this.pending[key] = request
      try { sessionStorage.setItem(storageKey, JSON.stringify(request)) } catch { /* Memory fallback. */ }
      this.busy[key] = true
      const clear = () => { delete this.pending[key]; try { sessionStorage.removeItem(storageKey) } catch { /* Memory fallback. */ } }
      try {
        const result = await apiPost<Result>(`/sessions/${encodeURIComponent(sessionId)}/briefs/${encodeURIComponent(briefId)}/reject`, request,
          { timeoutMs: 20_000, timeoutMessage: '修订结果尚未核实，请原样重试。' })
        if (!result || result.accepted !== true || result.sessionId !== sessionId || result.briefId !== briefId || result.dataEpoch !== request.dataEpoch ||
          typeof result.routingId !== 'string' || !result.routingId || !isReviseIntentBriefInput(result.request) ||
          !same(result.request, request) || result.request.idempotencyKey !== request.idempotencyKey || typeof result.idempotentReplay !== 'boolean') {
          throw new Error('修订回执与原草稿不匹配，请原样重试核实结果。')
        }
        clear(); return result
      } catch (error) {
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) clear()
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
