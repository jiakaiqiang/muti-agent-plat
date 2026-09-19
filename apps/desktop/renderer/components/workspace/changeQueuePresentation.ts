import { changeQueueView, type ChangeQueueInput, type ChangeQueueRow, type ChangeQueueStaleReason } from '@agent-cluster/shared'

/**
 * Desktop rendering of the execution-time change queue. The business state is
 * the shared projection — same order, same staleness, same "not authorised"
 * flag as web — but this end groups the queue into titled sections instead of
 * one inline list.
 */
export interface ChangeQueueRowView extends ChangeQueueRow {
  staleLabel?: string
}

export type ChangeQueueSectionKey = 'awaiting_user' | 'deferred' | 'in_progress'

export interface ChangeQueueSection {
  key: ChangeQueueSectionKey
  title: string
  rows: ChangeQueueRowView[]
}

export interface ChangeQueuePanel {
  sections: ChangeQueueSection[]
  total: number
  staleCount: number
  needsDecision: boolean
  grantsExecution: false
  reconfirmationNotice: string
}

const STALE_LABELS: Record<ChangeQueueStaleReason, string> = {
  work_item_revision_changed: '需求已改版，需重新分析',
  document_revision_changed: '需求文档已改版，需重新分析'
}

const SECTION_TITLES: Record<ChangeQueueSectionKey, string> = {
  awaiting_user: '等待你选择',
  deferred: '已暂缓',
  in_progress: '处理中'
}

function rowView(row: ChangeQueueRow): ChangeQueueRowView {
  return { ...row, ...(row.staleReason ? { staleLabel: STALE_LABELS[row.staleReason] } : {}) }
}

export function buildChangeQueuePanel(input: ChangeQueueInput): ChangeQueuePanel {
  const view = changeQueueView(input)
  const grouped: Record<ChangeQueueSectionKey, ChangeQueueRowView[]> = {
    awaiting_user: [],
    deferred: [],
    in_progress: []
  }
  for (const row of view.items) {
    const key: ChangeQueueSectionKey = row.awaitingUser
      ? 'awaiting_user'
      : row.status === 'deferred' ? 'deferred' : 'in_progress'
    grouped[key].push(rowView(row))
  }

  return {
    // An empty section is not drawn: a titled block with no rows reads as a
    // state the user has to act on.
    sections: (['awaiting_user', 'deferred', 'in_progress'] as ChangeQueueSectionKey[])
      .filter((key) => grouped[key].length)
      .map((key) => ({ key, title: SECTION_TITLES[key], rows: grouped[key] })),
    total: view.total,
    staleCount: view.staleItems.length,
    needsDecision: view.needsDecision,
    grantsExecution: view.grantsExecution,
    reconfirmationNotice: '排队不等于已获批执行：处理前仍需重新确认需求文档并选择工作流。'
  }
}
