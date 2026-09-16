import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

describe('SessionWorkspace Session stop controls', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')
  const stoppableStatuses = source.match(
    /const stoppableSessionStatuses = new Set<SessionStatus>\(\[([\s\S]*?)\]\)/
  )?.[1] ?? ''

  it('offers stop only for interruptible phases and resume only for PAUSED', () => {
    expect(stoppableStatuses).toContain("'AGENT_DISCUSSING',")
    expect(stoppableStatuses).toContain("'REVISING_BRIEF',")
    expect(stoppableStatuses).toContain("'EXECUTING',")
    expect(stoppableStatuses).toContain("'POST_REVIEW',")
    expect(stoppableStatuses).toContain("'REWORKING'")
    expect(stoppableStatuses).not.toContain("'APPLYING_CHANGES'")
    expect(source).toContain("derivedStatus.value === 'PAUSED'")
  })

  it('waits for the server pause and resume operations before reconciling state', () => {
    expect(source).toContain('await sessionStore.pauseSession(sessionId)')
    expect(source).toContain('await sessionStore.resumeSession(sessionId)')
    expect(source).toContain('title="停止会话"')
    expect(source).toContain('title="继续会话"')
  })
})

describe('SessionWorkspace generic confirmation decisions', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')

  it('sends resume/cancel confirmations to the server instead of only appending a local event', () => {
    expect(source).toMatch(
      /if \(optionKey === 'resume' \|\| optionKey === 'cancel'\) \{[\s\S]*?await sessionStore\.resumeSession\(sessionId, confirmationId\)[\s\S]*?await sessionStore\.cancelSession\(sessionId, confirmationId\)/
    )
    // The generic branch must run before the local-only fallback event.
    expect(source.indexOf("if (optionKey === 'resume' || optionKey === 'cancel')"))
      .toBeLessThan(source.indexOf('id: `evt-local-${Date.now()}`'))
  })
})

describe('SessionWorkspace workflow Agent substitution', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')

  it('routes an explicit Agent option through the dedicated substitution API', () => {
    expect(source).toContain("activeConfirmation.value.reason === 'workflow_agent_substitution'")
    expect(source).toContain("optionKey.startsWith('agent:')")
    expect(source).toContain('await sessionStore.resolveWorkflowAgentSubstitution(sessionId')
    expect(source).toContain("if (optionKey === 'skip_agent')")
    expect(source).toContain('await sessionStore.resolveWorkflowAgentSkip(sessionId')
  })
})

describe('SessionWorkspace workflow runtime preflight', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')

  it('reconnects a local workspace before committing workflow selection', () => {
    expect(source).toContain('async function ensureWorkflowRuntimeReady()')
    expect(source).toContain('if (!localRuntimeStore.isConnected) localRuntimeStore.wakeLocalRuntime()')
    expect(source).toContain('await localRuntimeStore.ensureWorkspaceConnected(workingDirectory.id)')
    expect(source).toMatch(
      /if \(\!\(await ensureWorkflowRuntimeReady\(\)\)\) return[\s\S]*?appendOptimisticConfirmationResolution\(sessionId, confirmationId, optionKey\)/
    )
  })
})

describe('SessionWorkspace local directory picker lifecycle', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')

  it('cancels the active directory picker when the create-session dialog closes', () => {
    expect(source).toMatch(
      /function closeCreateSessionDialog\(\) \{[\s\S]*?localRuntimeStore\.cancelWorkspaceAuthorization\(\)[\s\S]*?sessionLocalRuntimeWorkspaceId\.value = ''[\s\S]*?sessionBindingStatus\.value = 'idle'[\s\S]*?workspaceUiStore\.closeCreateSession\(\)/
    )
  })

  it('uses a keepalive cancellation request when the browser refreshes or leaves', () => {
    expect(source).toContain("window.addEventListener('beforeunload', cancelLocalRuntimeAuthorizationOnPageExit)")
    expect(source).toContain("window.addEventListener('pagehide', cancelLocalRuntimeAuthorizationOnPageExit)")
    expect(source).toMatch(
      /function cancelLocalRuntimeAuthorizationOnPageExit\(\) \{[\s\S]*?cancelWorkspaceAuthorization\(\{ keepalive: true \}\)/
    )
  })

  it('ignores the expected browser abort after cancelling directory selection', () => {
    expect(source).toMatch(
      /async function authorizeLocalRuntimeWorkspace\(\)[\s\S]*?catch \(error\) \{[\s\S]*?if \(isAbortError\(error\)\) return/
    )
  })
})
