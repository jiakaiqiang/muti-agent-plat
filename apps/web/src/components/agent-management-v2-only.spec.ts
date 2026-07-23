import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const agentStore = readFileSync(resolve('src/stores/agent.ts'), 'utf8')
const agentManager = readFileSync(resolve('src/components/AgentManager.vue'), 'utf8')
const skillManager = readFileSync(resolve('src/components/SkillManager.vue'), 'utf8')

describe('Agent management v2-only boundary', () => {
  it('does not accept Runtime selection in Agent create/update payloads', () => {
    expect(agentStore).not.toMatch(/runtimeType|RuntimeType/)
  })

  it('does not accept model selection in Agent create/update payloads', () => {
    expect(agentStore).not.toMatch(/modelId/)
  })

  it('does not mutate legacy Agent skillIds', () => {
    expect(agentStore).not.toMatch(/skillIds|removeSkillReference/)
  })

  it('Agent cards do not display a legacy skillIds count', () => {
    expect(agentManager).not.toMatch(/skillIds/)
  })

  it('Skill management does not call Agent binding endpoints', () => {
    expect(skillManager).not.toMatch(/skillIds|\/agents\/|bindAgent|toggleAgent/)
  })

  it('Profile editor can insert stable Skill references', () => {
    expect(agentManager).toMatch(/\$\{skill:/)
  })

  it('Profile editor can insert stable Tool references', () => {
    expect(agentManager).toMatch(/\$\{tool:/)
  })

  it('Profile editor renders compiler diagnostics before save', () => {
    expect(agentManager).toMatch(/diagnostics/)
    expect(agentManager).toMatch(/validateProfile/)
  })
})
