import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SkillManager from './SkillManager.vue'
import { useAgentStore } from '@/stores/agent'
import type { Agent, Skill } from '@/types/contracts'

const agent: Agent = {
  id: 'requirements',
  key: 'requirements',
  name: '需求 Agent',
  role: '需求澄清与验收',
  runtimeType: 'mock',
  status: 'active',
  capabilityIds: [],
  skillIds: [],
  defaultKnowledgeBaseIds: [],
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z'
}

const createdSkill: Skill = {
  id: 'skill-contract-review',
  name: 'Contract Review',
  description: '发布前检查共享合同。',
  content: 'Always verify shared contracts before delivery.',
  files: [],
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z'
}

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? { error: data } : { data, requestId: 'skill-manager-spec' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function requestPath(input: RequestInfo | URL) {
  if (typeof input === 'string') return new URL(input).pathname
  if (input instanceof URL) return input.pathname
  return new URL(input.url).pathname
}

describe('SkillManager', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('在提交前将不安全文件路径定位到文件字段', async () => {
    fetchMock.mockImplementation(async () => apiResponse([]))
    const agentStore = useAgentStore()
    agentStore.agents = [agent]
    const wrapper = mount(SkillManager, { props: { agents: agentStore.agents } })
    await flushPromises()

    await wrapper.get('[data-testid="skill-create"]').trigger('click')
    await wrapper.get('[data-testid="skill-name"]').setValue('Safe Review')
    await wrapper.get('[data-testid="skill-content"]').setValue('Review every deployment artifact.')
    await wrapper.get('[data-testid="skill-add-file"]').trigger('click')
    await wrapper.get('[data-testid="skill-file-path-0"]').setValue('../secret.txt')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.text()).toContain('第 1 个文件的路径必须是安全的相对路径')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('创建 Skill 后可以绑定 Agent 并展示稳定的注入标记', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      if (path === '/api/skills' && !init?.method) return apiResponse([])
      if (path === '/api/skills' && init?.method === 'POST') return apiResponse(createdSkill)
      if (path === `/api/agents/${agent.id}/skills/${createdSkill.id}` && init?.method === 'POST') {
        return apiResponse({ agent: { ...agent, skillIds: [createdSkill.id] }, skill: createdSkill })
      }
      return apiResponse({ message: `Unexpected request: ${init?.method ?? 'GET'} ${path}` }, 500)
    })

    const agentStore = useAgentStore()
    agentStore.agents = [agent]
    const wrapper = mount(SkillManager, { props: { agents: agentStore.agents } })
    await flushPromises()

    await wrapper.get('[data-testid="skill-create"]').trigger('click')
    await wrapper.get('[data-testid="skill-name"]').setValue(createdSkill.name)
    await wrapper.get('[data-testid="skill-description"]').setValue(createdSkill.description ?? '')
    await wrapper.get('[data-testid="skill-content"]').setValue(createdSkill.content)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Contract Review')
    await wrapper.get(`[data-testid="skill-binding-${agent.id}"]`).trigger('click')
    await flushPromises()
    await wrapper.setProps({ agents: agentStore.agents })

    expect(wrapper.get('[data-testid="skill-injection-marker"]').text()).toBe('[Skill:Contract Review]')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/agents/${agent.id}/skills/${createdSkill.id}`),
      expect.objectContaining({ method: 'POST' })
    )
  })
})
