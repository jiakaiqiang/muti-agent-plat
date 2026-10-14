import { describe, expect, it } from 'vitest'
import type { DecisionRecord } from '@agent-cluster/shared'
import { effectiveBriefQuestionAnswers } from './briefQuestionAnswers'

const base: DecisionRecord = {
  id: 'parent-answer', sessionId: 'session-1', workItemId: 'parent', kind: 'requirement',
  status: 'confirmed', content: '不支持 CSV', question: '是否支持 CSV？', answer: '不支持',
  sourceEventId: 'event-1', revision: 1, createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

describe('effectiveBriefQuestionAnswers', () => {
  it('shows the child override and hides unrelated or superseded answers', () => {
    const child = { ...base, id: 'child-answer', workItemId: 'child', question: '是否支持 CSV?',
      answer: '支持', content: '支持 CSV' }
    const unrelated = { ...base, id: 'unrelated', workItemId: 'other', question: '是否支持 PDF？' }
    expect(effectiveBriefQuestionAnswers([base, child, unrelated], 'child', [base.id]))
      .toEqual([child])
  })
})
