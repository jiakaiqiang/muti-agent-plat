import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import { useAgentStore } from '@/stores/agent'

describe('Agent surface catalogs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  it('keeps system Agent identities available without exposing them as chat participants', async () => {
    const coordinator = defaultAgents.find((agent) => agent.key === 'coordinator')
    const chatAgents = defaultAgents.filter((agent) => agent.management?.allowedSurfaces.includes('chat'))
    expect(coordinator).toBeDefined()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: chatAgents,
      requestId: 'agent-surface-spec'
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })))

    const store = useAgentStore()
    await store.loadAgentsForSurface('chat')

    expect(store.agentName(coordinator!.id)).toBe(coordinator!.name)
    expect(store.agents.some((agent) => agent.id === coordinator!.id)).toBe(true)
    expect(store.chatAgents.some((agent) => agent.id === coordinator!.id)).toBe(false)
    expect(store.chatAgents.map((agent) => agent.id)).toEqual(chatAgents.map((agent) => agent.id))
  })
})
