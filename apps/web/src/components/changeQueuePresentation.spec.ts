import { describe, expect, it } from 'vitest'
import type { ChangeQueueItem } from '@agent-cluster/shared'
import { buildChangeQueuePanel } from './changeQueuePresentation'

function item(overrides: Partial<ChangeQueueItem> = {}): ChangeQueueItem {
  return {
    id: 'change-1',
    summary: '顺便加一个导出按钮',
    status: 'waiting_user',
    raisedAt: '2026-09-19T00:00:00.000Z',
    workItemRevision: 3,
    documentRevision: 2,
    ...overrides
  }
}

describe('change queue presentation (web)', () => {
  it('derives queue order and the open question from shared state', () => {
    const panel = buildChangeQueuePanel({
      items: [
        item({ id: 'second', raisedAt: '2026-09-19T02:00:00.000Z', summary: '第二条' }),
        item({ id: 'first', raisedAt: '2026-09-19T00:00:00.000Z', summary: '第一条' })
      ],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(panel.rows.map((row) => row.id)).toEqual(['first', 'second'])
    expect(panel.needsDecision).toBe(true)
    expect(panel.total).toBe(2)
  })

  it('labels each row for this end own inline list style', () => {
    const panel = buildChangeQueuePanel({
      items: [
        item({ id: 'waiting', status: 'waiting_user' }),
        item({ id: 'parked', status: 'deferred', raisedAt: '2026-09-19T01:00:00.000Z' })
      ],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    // The labels are this end's presentation; the statuses behind them are
    // business state shared with desktop.
    const byId = new Map(panel.rows.map((row) => [row.id, row]))
    expect(byId.get('waiting')?.statusLabel).toBe('等待你选择')
    expect(byId.get('parked')?.statusLabel).toBe('已暂缓')
    expect(byId.get('waiting')?.awaitingUser).toBe(true)
    expect(byId.get('parked')?.awaitingUser).toBe(false)
  })

  it('marks a stale row and explains which version moved', () => {
    const panel = buildChangeQueuePanel({
      items: [item({ id: 'old', workItemRevision: 2 })],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(panel.rows[0]?.stale).toBe(true)
    expect(panel.rows[0]?.staleLabel).toBe('需求已改版，需重新分析')
    expect(panel.staleCount).toBe(1)
  })

  it('never offers a start shortcut: a queued change is not authorised', () => {
    const panel = buildChangeQueuePanel({
      items: [item({ status: 'deferred' })],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(panel.grantsExecution).toBe(false)
    expect(panel.reconfirmationNotice).toBe('排队不等于已获批执行：处理前仍需重新确认需求文档并选择工作流。')
  })

  it('an empty queue renders nothing rather than a placeholder row', () => {
    const panel = buildChangeQueuePanel({ items: [], currentWorkItemRevision: 3, currentDocumentRevision: 2 })

    expect(panel.rows).toEqual([])
    expect(panel.total).toBe(0)
    expect(panel.needsDecision).toBe(false)
  })

  it('never carries private model reasoning into the panel', () => {
    const panel = buildChangeQueuePanel({
      items: [item({ privateReasoning: 'chain of thought that must not reach a client' } as never)],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(JSON.stringify(panel).includes('chain of thought')).toBe(false)
  })
})
