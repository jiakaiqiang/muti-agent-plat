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

describe('change queue presentation (desktop)', () => {
  it('derives the same queue order and open question as the web end', () => {
    const panel = buildChangeQueuePanel({
      items: [
        item({ id: 'second', raisedAt: '2026-09-19T02:00:00.000Z', summary: '第二条' }),
        item({ id: 'first', raisedAt: '2026-09-19T00:00:00.000Z', summary: '第一条' })
      ],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(panel.sections.flatMap((section) => section.rows.map((row) => row.id))).toEqual(['first', 'second'])
    expect(panel.needsDecision).toBe(true)
    expect(panel.total).toBe(2)
  })

  it('groups the queue into sections, which is this end own style', () => {
    const panel = buildChangeQueuePanel({
      items: [
        item({ id: 'waiting', status: 'waiting_user' }),
        item({ id: 'parked', status: 'deferred', raisedAt: '2026-09-19T01:00:00.000Z' })
      ],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    // Same business split as web (awaitingUser vs deferred); desktop renders it
    // as titled sections instead of one inline list.
    expect(panel.sections.map((section) => [section.key, section.rows.map((row) => row.id)])).toEqual([
      ['awaiting_user', ['waiting']],
      ['deferred', ['parked']]
    ])
    expect(panel.sections[0]?.title).toBe('等待你选择')
    expect(panel.sections[1]?.title).toBe('已暂缓')
  })

  it('a section with no rows is not rendered at all', () => {
    const panel = buildChangeQueuePanel({
      items: [item({ status: 'deferred' })],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    expect(panel.sections.map((section) => section.key)).toEqual(['deferred'])
    expect(panel.needsDecision).toBe(false)
  })

  it('marks a stale row and explains which version moved', () => {
    const panel = buildChangeQueuePanel({
      items: [item({ id: 'old', documentRevision: 1 })],
      currentWorkItemRevision: 3,
      currentDocumentRevision: 2
    })

    const row = panel.sections.flatMap((section) => section.rows)[0]
    expect(row?.stale).toBe(true)
    expect(row?.staleLabel).toBe('需求文档已改版，需重新分析')
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

  it('an empty queue renders no sections', () => {
    const panel = buildChangeQueuePanel({ items: [], currentWorkItemRevision: 3, currentDocumentRevision: 2 })

    expect(panel.sections).toEqual([])
    expect(panel.total).toBe(0)
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
