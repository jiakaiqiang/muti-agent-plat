import { changeQueueView, type ChangeQueueInput, type ChangeQueueRow, type ChangeQueueStaleReason } from '@agent-cluster/shared'

/**
 * Web rendering of the execution-time change queue. Order, staleness and
 * "is this authorised" come from the shared projection so both clients agree;
 * this module only adds the labels for the inline list this end draws.
 */
export interface ChangeQueueRowView extends ChangeQueueRow {
  statusLabel: string
  staleLabel?: string
}

export interface ChangeQueuePanel {
  rows: ChangeQueueRowView[]
  total: number
  staleCount: number
  needsDecision: boolean
  grantsExecution: false
  reconfirmationNotice: string
}

const STATUS_LABELS: Record<string, string> = {
  received: '已收到',
  analyzing: '正在分析影响',
  waiting_user: '等待你选择',
  deferred: '已暂缓',
  stopping: '正在停稳',
  revising: '正在修订需求',
  waiting_confirmation: '等待重新确认'
}

const STALE_LABELS: Record<ChangeQueueStaleReason, string> = {
  work_item_revision_changed: '需求已改版，需重新分析',
  document_revision_changed: '需求文档已改版，需重新分析'
}

export function buildChangeQueuePanel(input: ChangeQueueInput): ChangeQueuePanel {
  const view = changeQueueView(input)
  return {
    rows: view.items.map((row) => ({
      ...row,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      ...(row.staleReason ? { staleLabel: STALE_LABELS[row.staleReason] } : {})
    })),
    total: view.total,
    staleCount: view.staleItems.length,
    needsDecision: view.needsDecision,
    grantsExecution: view.grantsExecution,
    // Rendered next to the list so the queue is never mistaken for a green light.
    reconfirmationNotice: '排队不等于已获批执行：处理前仍需重新确认需求文档并选择工作流。'
  }
}
