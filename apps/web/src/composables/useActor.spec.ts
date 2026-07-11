import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '@/stores/agent'
import type { CollaborationEvent } from '@/types/contracts'
import { actorAgentId, eventAgentId, resolveActor } from './useActor'

function makeEvent(overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: 'e-1',
    sessionId: 's-1',
    type: 'agent_message',
    toAgentIds: [],
    content: '',
    metadata: { schemaVersion: '0.1', payload: {} },
    createdAt: new Date().toISOString(),
    ...overrides
  } as CollaborationEvent
}

describe('resolveActor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useAgentStore()
    // 直接注入若干 agent 以便 agentName 能查到
    store.$patch({
      agents: [
        { id: 'a1', key: 'coder', name: 'Coder', role: 'coder' }
      ] as never
    })
  })

  it('优先读取 event.actor:agent', () => {
    const r = resolveActor(makeEvent({ actor: { type: 'agent', id: 'a1' } }))
    expect(r.type).toBe('agent')
    expect(r.id).toBe('a1')
    expect(r.displayName).toBe('Coder')
  })

  it('event.actor 缺失时回退 fromAgentId', () => {
    const r = resolveActor(makeEvent({ fromAgentId: 'a1' }))
    expect(r.type).toBe('agent')
    expect(r.id).toBe('a1')
    expect(r.displayName).toBe('Coder')
  })

  it('user_message 且无 actor → user', () => {
    const r = resolveActor(makeEvent({ type: 'user_message' }))
    expect(r.type).toBe('user')
    expect(r.displayName).toBe('你')
  })

  it('actor.type=system → 系统展示,无 avatarKey', () => {
    const r = resolveActor(
      makeEvent({ type: 'session_status_changed', actor: { type: 'system', id: 'system' } })
    )
    expect(r.type).toBe('system')
    expect(r.avatarKey).toBeUndefined()
  })

  it('actorAgentId 优先读取 ActorRef 并兼容旧字段', () => {
    expect(actorAgentId({ type: 'agent', id: 'new-agent' }, 'legacy-agent')).toBe('new-agent')
    expect(actorAgentId(undefined, 'legacy-agent')).toBe('legacy-agent')
    expect(eventAgentId(makeEvent({ actor: { type: 'agent', id: 'new-agent' }, fromAgentId: 'legacy-agent' }))).toBe('new-agent')
  })
})
