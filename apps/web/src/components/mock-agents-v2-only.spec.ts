import { describe, expect, it } from 'vitest'
import { mockAgents } from '../mock/mockEvents'

describe('mock Agent definitions v2-only boundary', () => {
  it('does not bind a Runtime to an Agent', () => {
    expect(mockAgents.every((agent) => !('runtimeType' in agent))).toBe(true)
  })

  it('does not bind a model to an Agent', () => {
    expect(mockAgents.every((agent) => !('modelId' in agent))).toBe(true)
  })

  it('does not persist legacy skillIds', () => {
    expect(mockAgents.every((agent) => !('skillIds' in agent))).toBe(true)
  })

  it('provides Profile Markdown for every Agent identity', () => {
    expect(mockAgents.every((agent) => agent.profileMarkdown.trim().length > 0)).toBe(true)
  })

  it('provides tags for routing and discovery metadata', () => {
    expect(mockAgents.every((agent) => Array.isArray(agent.tags) && agent.tags.length > 0)).toBe(true)
  })

  it('provides a positive Profile revision', () => {
    expect(mockAgents.every((agent) => Number.isInteger(agent.profileRevision) && agent.profileRevision > 0)).toBe(true)
  })

  it('uses only v2 Agent lifecycle states', () => {
    expect(mockAgents.every((agent) => agent.status === 'active' || agent.status === 'disabled')).toBe(true)
  })

  it('keeps stable identity, authority, and knowledge references', () => {
    expect(
      mockAgents.every(
        (agent) =>
          agent.id.length > 0 &&
          agent.key.length > 0 &&
          agent.capabilityIds.length > 0 &&
          agent.defaultKnowledgeBaseIds.length > 0
      )
    ).toBe(true)
  })
})
