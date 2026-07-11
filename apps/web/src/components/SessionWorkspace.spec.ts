import { describe, expect, it, vi } from 'vitest'
import type { PostReviewAction } from '@/types/contracts'
import { resolveSessionWorkspacePostReviewAction } from './session-workspace-post-review-action'

describe('SessionWorkspace Post Review action routing', () => {
  it('routes each action to its own recovery handler instead of resume', async () => {
    const actions: PostReviewAction[] = [
      {
        action: 'request_workspace_context',
        reason: 'Read the missing source.',
        missingPaths: ['src/feature.ts']
      },
      {
        action: 'deliver_with_limitations',
        limitations: ['src/feature.ts was not reviewed.']
      },
      { action: 'save_progress' },
      { action: 'cancel', reason: 'Stop the task.' }
    ]
    const handlers = {
      requestWorkspaceContext: vi.fn(async () => undefined),
      deliverWithLimitations: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined)
    }

    for (const action of actions) {
      const handled = await resolveSessionWorkspacePostReviewAction(action.action, actions, handlers)
      expect(handled).toBe(true)
    }

    expect(handlers.requestWorkspaceContext).toHaveBeenCalledWith(actions[0])
    expect(handlers.deliverWithLimitations).toHaveBeenCalledWith(actions[1])
    expect(handlers.saveProgress).toHaveBeenCalledWith(actions[2])
    expect(handlers.cancel).toHaveBeenCalledWith(actions[3])
    expect(Object.keys(handlers)).not.toContain('resume')
  })
})
