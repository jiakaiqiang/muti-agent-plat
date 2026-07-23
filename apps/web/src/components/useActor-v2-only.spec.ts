import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '@/stores/agent'
import type { CollaborationEvent } from '@/types/contracts'
import { actorAgentId, eventActor, eventAgentId, resolveActor } from '../composables/useActor'

function makeEvent(overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: 'e-1',
    sessionId: 's-1',
    type: 'agent_message',
    actor: { type: 'system', id: 'system' },
    toAgentIds: [],
    content: '',
    metadata: { schemaVersion: '0.1', payload: {} },
    createdAt: new Date().toISOString(),
    ...overrides
  } as CollaborationEvent
}

describe('v2-only ActorRef resolution', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentStore().$patch({
      agents: [{ id: 'a1', key: 'coder', name: 'Coder', role: 'coder' }] as never
    })
  })

  it('resolves an agent from event.actor', () => {
    expect(resolveActor(makeEvent({ actor: { type: 'agent', id: 'a1' } }))).toEqual({
      type: 'agent',
      id: 'a1',
      displayName: 'Coder',
      avatarKey: 'a1'
    })
  })

  it('keeps an unknown agent identity without inventing a display name', () => {
    const actor = resolveActor(makeEvent({ actor: { type: 'agent', id: 'unknown' } }))
    expect(actor.displayName).toBe('unknown')
    expect(actor.avatarKey).toBe('unknown')
  })

  it('resolves a user from event.actor', () => {
    const actor = resolveActor(makeEvent({ type: 'user_message', actor: { type: 'user', id: 'user-1' } }))
    expect(actor.type).toBe('user')
    expect(actor.id).toBe('user-1')
  })

  it('resolves a system actor without an avatar', () => {
    const actor = resolveActor(makeEvent())
    expect(actor.type).toBe('system')
    expect(actor.avatarKey).toBeUndefined()
  })

  it('uses a user authority default only for user messages missing actor', () => {
    expect(eventActor(makeEvent({ type: 'user_message', actor: undefined }))).toEqual({ type: 'user', id: 'system' })
  })

  it('uses a system authority default for non-user events missing actor', () => {
    expect(eventActor(makeEvent({ actor: undefined }))).toEqual({ type: 'system', id: 'system' })
  })

  it('extracts an id only from an agent ActorRef', () => {
    expect(actorAgentId({ type: 'agent', id: 'a1' })).toBe('a1')
    expect(actorAgentId({ type: 'user', id: 'user-1' })).toBeUndefined()
    expect(actorAgentId({ type: 'system', id: 'system' })).toBeUndefined()
    expect(actorAgentId(undefined)).toBeUndefined()
  })

  it('eventAgentId reads only the authoritative event.actor', () => {
    expect(eventAgentId(makeEvent({ actor: { type: 'agent', id: 'a1' } }))).toBe('a1')
    expect(eventAgentId(makeEvent({ actor: { type: 'system', id: 'system' } }))).toBeUndefined()
    expect(eventAgentId(makeEvent({ actor: undefined }))).toBeUndefined()
  })
})
