import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WorkflowManager from './WorkflowManager.vue'
import { useAgentStore } from '@/stores/agent'
import type { AgentDefinition, WorkflowDefinition } from '@/types/contracts'

const agent: AgentDefinition = {
  id: 'agent-requirements', key: 'requirements', name: '需求分析师', role: '需求分析',
  profileMarkdown: '# Requirements', tags: ['requirements'], status: 'active', capabilityIds: ['cap-brief'],
  defaultKnowledgeBaseIds: [], profileRevision: 1, createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z'
}

const workflow: WorkflowDefinition = {
  id: 'workflow-1', name: '研发流程', status: 'draft', draftRevision: 1, version: 1,
  nodes: [], edges: [], createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z'
}

const WorkflowCanvasStub = {
  props: ['nodes'],
  emits: ['select', 'insert', 'remove', 'reorder'],
  template: '<div data-testid="workflow-canvas"><article v-for="node in nodes" :key="node.id" class="workflow-builder-node">{{ node.type }}</article></div>'
}

function response(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'workflow-manager-spec' }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function mountManager(pinia: ReturnType<typeof createPinia>) {
  return mount(WorkflowManager, { global: { plugins: [pinia], stubs: { WorkflowCanvas: WorkflowCanvasStub } } })
}

describe('WorkflowManager', () => {
  const fetchMock = vi.fn()
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    useAgentStore().agents = [agent]
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('adds Agent, human approval and robot approval nodes and saves the draft', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/agents?surface=workflow')) return response([agent])
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Partial<WorkflowDefinition>
        return response({ ...workflow, ...body, draftRevision: 2, version: 2 })
      }
      return response([workflow])
    })
    const wrapper = mountManager(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="workflow-edit-workflow-1"]').trigger('click')
    await wrapper.get('.workflow-agent-resource').trigger('click')
    await wrapper.get('.resource-item.human').trigger('click')
    await wrapper.get('.resource-item.robot').trigger('click')
    expect(wrapper.findAll('.workflow-builder-node')).toHaveLength(3)
    await wrapper.get('[data-testid="workflow-save"]').trigger('click')
    await flushPromises()
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    const body = JSON.parse(String(patchCall?.[1]?.body))
    expect(body.expectedDraftRevision).toBe(1)
    expect(body.nodes.map((node: { type: string }) => node.type)).toEqual(['agent', 'human_approval', 'robot_approval'])
    expect(wrapper.text()).toContain('草稿已保存（修订 2）')
  })

  it('creates a dedicated draft with no implicit publication', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/agents?surface=workflow')) return response([agent])
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Partial<WorkflowDefinition>
        return response({ ...workflow, ...body, id: 'workflow-created' })
      }
      return response([])
    })
    const wrapper = mountManager(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="workflow-create"]').trigger('click')
    await wrapper.get('input[placeholder="请输入工作流名称"]').setValue('需求交付流程')
    await wrapper.get('.workflow-agent-resource').trigger('click')
    await wrapper.get('[data-testid="workflow-save"]').trigger('click')
    await flushPromises()
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    const body = JSON.parse(String(postCall?.[1]?.body))
    expect(body.name).toBe('需求交付流程')
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]).toMatchObject({
      stageDescription: '需求分析',
      inputContract: [],
      outputContract: ['需求分析师阶段执行结果。']
    })
    expect(body.status).toBeUndefined()
  })

  it('saves then publishes an exact immutable version', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/agents?surface=workflow')) return response([agent])
      if (url.endsWith('/publish')) {
        return response({ ...workflow, id: 'workflow-published', name: '发布流程', status: 'published', currentPublishedVersion: 1 })
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Partial<WorkflowDefinition>
        return response({ ...workflow, ...body, id: 'workflow-published' })
      }
      return response([])
    })
    const wrapper = mountManager(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="workflow-create"]').trigger('click')
    await wrapper.get('input[placeholder="请输入工作流名称"]').setValue('发布流程')
    await wrapper.get('.workflow-agent-resource').trigger('click')
    await wrapper.get('.editor-actions .primary-button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/workflows/workflow-published/publish'))).toBe(true)
    expect(wrapper.text()).toContain('工作流已发布为 v1')
    expect(wrapper.find('[data-testid="workflow-create"]').exists()).toBe(true)
    expect(wrapper.find('.editor-grid').exists()).toBe(false)
    expect(wrapper.get('[data-testid="workflow-edit-workflow-published"]').exists()).toBe(true)
    expect(wrapper.get('.status-badge.published').text()).toBe('已发布')
  })
})
