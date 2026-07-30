import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceUiStore } from './workspaceUi'

describe('workspace UI store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('owns and resets the create-session flow state', () => {
    const store = useWorkspaceUiStore()

    store.newSessionInput = 'old input'
    store.selectedSessionAgentIds = ['agent-1']
    store.sessionCreateError = 'old error'
    store.sessionRuntimeType = 'codex'
    store.openCreateSession()

    expect(store.showCreateSessionDialog).toBe(true)
    expect(store.newSessionInput).toBe('')
    expect(store.selectedSessionAgentIds).toEqual([])
    expect(store.sessionCreateError).toBe('')
    expect(store.sessionRuntimeType).toBe('')
    expect(store.sessionWorkspaceKind).toBe('local_bridge')

    store.toggleSessionAgent('agent-1')
    store.toggleSessionAgent('agent-2')
    store.toggleSessionAgent('agent-1')
    expect(store.selectedSessionAgentIds).toEqual(['agent-2'])
  })

  it('shares timed notifications without exposing timer handles as state', () => {
    vi.useFakeTimers()
    const store = useWorkspaceUiStore()

    store.showMessage('saved', 'success')
    expect(store.uiMessage).toMatchObject({ text: 'saved', type: 'success' })

    vi.advanceTimersByTime(2600)
    expect(store.uiMessage).toBeUndefined()
  })
})
