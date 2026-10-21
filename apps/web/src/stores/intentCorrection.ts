import { defineStore } from 'pinia'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'
import type { CorrectIntentRoutingInput } from '@agent-cluster/shared'
import {
  normalizeCorrectionRoutes, normalizeCorrectionRoute, normalizeCorrectionHistory, normalizeCorrectionReceipt,
  normalizeCorrectionTargets, type CorrectionRoute, type CorrectionSummary, type CorrectionReceipt,
  type BoundCorrectionRequest
} from '@/utils/intentCorrectionModel'

export const correctionKey = (sessionId: string, routingId: string) => JSON.stringify([sessionId, routingId])
const basePath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`
const routePath = (sessionId: string, routingId: string) => `${basePath(sessionId)}/message-routings/${encodeURIComponent(routingId)}`

/** Shared by Web and Desktop. Requests stay bound across navigation and uncertain transport outcomes. */
export const useIntentCorrectionStore = defineStore('intentCorrection', {
  state: () => ({
    routes: {} as Record<string, CorrectionRoute>,
    histories: {} as Record<string, CorrectionSummary[]>,
    receipts: {} as Record<string, CorrectionReceipt>,
    pending: {} as Record<string, BoundCorrectionRequest>,
    busy: {} as Record<string, boolean>,
    readGeneration: {} as Record<string, number>
  }),
  actions: {
    recordRoute(route: CorrectionRoute) {
      const key = correctionKey(route.sessionId, route.id)
      if ((this.routes[key]?.revision ?? 0) <= route.revision) this.routes[key] = route
    },
    async findRoutes(sessionId: string, sourceEventId: string, signal?: AbortSignal) {
      const data = await apiGet<unknown>(`${basePath(sessionId)}/message-routings?sourceEventId=${encodeURIComponent(sourceEventId)}`, { signal })
      const routes = normalizeCorrectionRoutes(data, sessionId, sourceEventId)
      if (!signal?.aborted) routes.forEach(route => this.recordRoute(route))
      return routes
    },
    async loadTargets(sessionId: string, signal?: AbortSignal) {
      const [works, decisions] = await Promise.all([
        apiGet<unknown>(`${basePath(sessionId)}/work-items`, { signal }),
        apiGet<unknown>(`${basePath(sessionId)}/decisions`, { signal })
      ])
      return normalizeCorrectionTargets(works, decisions, sessionId)
    },
    async refresh(sessionId: string, routingId: string, signal?: AbortSignal) {
      const key = correctionKey(sessionId, routingId)
      const generation = (this.readGeneration[key] ?? 0) + 1
      this.readGeneration[key] = generation
      const [routeData, historyData] = await Promise.all([
        apiGet<unknown>(routePath(sessionId, routingId), { signal }),
        apiGet<unknown>(`${routePath(sessionId, routingId)}/corrections`, { signal })
      ])
      const route = normalizeCorrectionRoute(routeData, sessionId)
      if (route.id !== routingId) throw new Error('路由与原消息不匹配，请重新打开原消息。')
      const history = normalizeCorrectionHistory(historyData, sessionId, routingId)
      if (signal?.aborted || this.readGeneration[key] !== generation) return
      this.recordRoute(route)
      const merged = new Map((this.histories[key] ?? []).map(row => [row.id, row]))
      for (const row of history) {
        const previous = merged.get(row.id)
        if (!previous || row.routingRevision > previous.routingRevision ||
          (row.routingRevision === previous.routingRevision && Date.parse(row.updatedAt) >= Date.parse(previous.updatedAt))) merged.set(row.id, row)
      }
      this.histories[key] = [...merged.values()].sort((a, b) => b.revision - a.revision)
      const pending = this.pending[key]
      if (pending && history.some(row => row.idempotencyKey === pending.payload.idempotencyKey)) delete this.pending[key]
    },
    prepare(sessionId: string, routingId: string, input: Pick<CorrectIntentRoutingInput,
      'instruction' | 'targetWorkItemId' | 'supersedesDecisionId' | 'expectedDecisionRevision'>) {
      const key = correctionKey(sessionId, routingId)
      if (this.pending[key]) throw new Error('上一次提交的结果尚未确认，请先刷新或重试原请求。')
      const route = this.routes[key]
      if (!route) throw new Error('请先加载原消息的当前理解。')
      if (!input.instruction.trim() || input.instruction.length > 8000) throw new Error('请输入 1 至 8000 字的纠正内容。')
      const bound: BoundCorrectionRequest = { sessionId, routingId, payload: {
        ...input, contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.revision,
        idempotencyKey: crypto.randomUUID()
      } }
      this.pending[key] = bound
      return bound
    },
    async submit(sessionId: string, routingId: string) {
      const key = correctionKey(sessionId, routingId)
      const bound = this.pending[key]
      if (!bound) throw new Error('没有待提交的纠错请求。')
      if (this.busy[key]) throw new Error('纠错请求正在提交。')
      // Capture all values before awaiting; neither current selection nor caller mutation can retarget a retry.
      const payload = { ...bound.payload }
      this.busy[key] = true
      try {
        const data = await apiPost<unknown>(`${routePath(bound.sessionId, bound.routingId)}/corrections`, payload,
          { timeoutMs: 20_000, timeoutMessage: '提交结果尚未确认，请刷新或重试原请求。' })
        const receipt = normalizeCorrectionReceipt(data, bound.routingId)
        this.receipts[key] = receipt
        delete this.pending[key]
        return receipt
      } catch (error) {
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
          delete this.pending[key]
          if ([409, 410].includes(error.status)) {
            await this.refresh(bound.sessionId, bound.routingId).catch(() => undefined)
          }
        }
        // Network/server failures can follow a committed acceptance. Preserve exactly the same request.
        throw error
      } finally {
        this.busy[key] = false
      }
    }
  }
})
