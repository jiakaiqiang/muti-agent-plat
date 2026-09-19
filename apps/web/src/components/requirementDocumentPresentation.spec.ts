import { describe, expect, it } from 'vitest'
import type { DocumentVersionSummary, RequirementDocumentSections } from '@agent-cluster/shared'
import { buildDiscussionPanel, buildDocumentVersionPanel } from './requirementDocumentPresentation'

function version(overrides: Partial<DocumentVersionSummary> = {}): DocumentVersionSummary {
  return {
    documentId: 'doc-1',
    documentRevision: 1,
    workItemRevision: 3,
    contentHash: 'hash-1',
    status: 'formal',
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  }
}

function sections(overrides: Partial<RequirementDocumentSections> = {}): RequirementDocumentSections {
  return {
    goal: '导出订单',
    scope: ['Excel 导出'],
    outOfScope: [],
    acceptanceCriteria: ['可打开'],
    risks: [],
    pendingItems: [],
    ...overrides
  }
}

describe('requirement document presentation (web)', () => {
  it('derives the current version and what the user must act on from shared state', () => {
    const panel = buildDocumentVersionPanel({
      versions: [
        version({ documentRevision: 1, contentHash: 'hash-1', status: 'superseded' }),
        version({ documentRevision: 2, contentHash: 'hash-2', status: 'formal' })
      ]
    })

    expect(panel.currentRevision).toBe(2)
    expect(panel.awaitingConfirmation).toBe(true)
    expect(panel.versions.map((item) => item.documentRevision)).toEqual([2, 1])
  })

  it('renders changed sections as inline diff rows and leaves unchanged ones out', () => {
    const panel = buildDocumentVersionPanel({
      versions: [version({ documentRevision: 2, contentHash: 'hash-2' }), version({ documentRevision: 1, status: 'superseded' })],
      previousSections: sections(),
      nextSections: sections({ goal: '导出订单与退款', risks: ['列数过多'] })
    })

    expect(panel.changedSections.sort()).toEqual(['goal', 'risks'])
    // Web renders one inline add/remove preview per changed section; the set of
    // changed sections is business state, the row shape is this end's style.
    expect(panel.diffs.map((item) => item.section).sort()).toEqual(['goal', 'risks'])
    const goal = panel.diffs.find((item) => item.section === 'goal')
    expect(goal?.preview.rows.some((row) => row.kind === 'add')).toBe(true)
    expect(panel.diffs.some((item) => item.section === 'acceptanceCriteria')).toBe(false)
  })

  it('marks a card bound to an older version as stale with the revision to read', () => {
    const panel = buildDocumentVersionPanel({
      versions: [version({ documentRevision: 2, contentHash: 'hash-2' }), version({ documentRevision: 1, contentHash: 'hash-1', status: 'superseded' })]
    })

    expect(panel.staleness({ documentId: 'doc-1', documentRevision: 1, contentHash: 'hash-1' })).toEqual({
      stale: true,
      currentRevision: 2,
      reason: 'revision_superseded'
    })
    expect(panel.staleness({ documentId: 'doc-1', documentRevision: 2, contentHash: 'hash-2' })).toEqual({
      stale: false,
      currentRevision: 2
    })
  })

  it('shows who is still consulting, who answered and who failed', () => {
    const panel = buildDiscussionPanel({
      status: 'consulting',
      objective: '确认导出范围',
      exitCondition: '两位专家给出结论',
      round: 1,
      roundLimit: 3,
      delegations: [
        { targetAgentId: 'architect', objective: '评估架构', status: 'completed', conclusion: '按 Excel 实现' },
        { targetAgentId: 'backend', objective: '评估接口', status: 'running' },
        { targetAgentId: 'test', objective: '评估验收', status: 'failed', failureReason: 'Runtime 超时' }
      ]
    })

    expect(panel.headline).toBe('正在咨询专家')
    expect(panel.roundLabel).toBe('第 1/3 轮')
    expect(panel.pendingAgentIds).toEqual(['backend'])
    expect(panel.answeredAgentIds).toEqual(['architect'])
    expect(panel.failures).toEqual([{ targetAgentId: 'test', failureReason: 'Runtime 超时' }])
    // A round with a failed expert must not read as a finished answer.
    expect(panel.completeAnswer).toBe(false)
  })

  it('never carries private model reasoning into the panel', () => {
    const panel = buildDiscussionPanel({
      status: 'ready_for_confirmation',
      objective: 'o',
      exitCondition: 'e',
      round: 1,
      roundLimit: 1,
      delegations: [
        {
          targetAgentId: 'architect',
          objective: 'a',
          status: 'completed',
          conclusion: 'ok',
          privateReasoning: 'chain of thought that must not reach a client'
        } as never
      ]
    })

    expect(JSON.stringify(panel).includes('chain of thought')).toBe(false)
  })
})
