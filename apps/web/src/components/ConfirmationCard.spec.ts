import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ConfirmationCard from './ConfirmationCard.vue'
import type { ConfirmationCardState, WorkflowDefinition } from '@/types/contracts'

function postReviewConfirmation(): ConfirmationCardState {
  return {
    confirmationId: 'confirmation-post-review',
    reason: 'coordinator_routing_needs_user_decision' as ConfirmationCardState['reason'],
    title: '复盘需要用户选择', description: '当前证据不足，请选择下一步。', status: 'pending',
    options: [{ key: 'resume', label: '继续执行', style: 'primary' }, { key: 'cancel', label: '取消' }],
    actions: [
      { action: 'request_workspace_context', reason: '复盘需要读取实现文件。', missingPaths: ['src/feature.ts'] },
      { action: 'deliver_with_limitations', limitations: ['src/feature.ts 尚未复核。'] },
      { action: 'save_progress' },
      { action: 'cancel', reason: '停止当前任务。' }
    ]
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ConfirmationCard', () => {
  it('does not duplicate the file revision candidate confirmation', () => {
    const wrapper = mount(ConfirmationCard, {
      props: {
        confirmation: {
          confirmationId: 'revision-confirmation',
          reason: 'confirm_file_revision_apply',
          title: '确认文件修订处理结果',
          description: '候选由统一产物编辑器承载。',
          status: 'pending',
          options: [{ key: 'apply_candidate', label: '确认并写回' }]
        }
      },
      global: { plugins: [createPinia()] }
    })
    expect(wrapper.find('.confirmation-card').exists()).toBe(false)
  })

  it('renders structured post-review actions', async () => {
    const wrapper = mount(ConfirmationCard, { props: { confirmation: postReviewConfirmation() }, global: { plugins: [createPinia()] } })
    expect(wrapper.text()).toContain('补读工作区')
    expect(wrapper.text()).toContain('src/feature.ts')
    expect(wrapper.text()).toContain('受限交付')
    expect(wrapper.text()).toContain('保存当前进度')
    expect(wrapper.text()).toContain('取消任务')
    expect(wrapper.text()).not.toContain('继续执行')
    await wrapper.get('[data-action="request_workspace_context"]').trigger('click')
    expect(wrapper.emitted('resolve')).toEqual([['request_workspace_context']])
  })

  it('opens published workflows with no default selection and emits the exact version', async () => {
    const published: WorkflowDefinition = {
      id: 'wf-published', name: '需求交付流程', description: '需求到验收', status: 'published', draftRevision: 3,
      currentPublishedVersion: 2, version: 3,
      nodes: [
        { id: 'agent-node', type: 'agent', agentId: 'requirements', order: 0 },
        { id: 'human-node', type: 'human_approval', title: '确认需求', assignee: 'session_owner', allowedDecisions: ['approve'], order: 1 }
      ],
      edges: [{ id: 'edge', sourceNodeId: 'agent-node', targetNodeId: 'human-node' }],
      createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z'
    }
    const draft = { ...published, id: 'wf-draft', name: '未发布流程', status: 'draft' as const, currentPublishedVersion: undefined }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [published, draft] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const confirmation: ConfirmationCardState = {
      confirmationId: 'select-1', reason: 'select_workflow', title: '选择工作流', description: '选择后开始执行',
      status: 'pending', options: [], workflowOptions: []
    }
    const wrapper = mount(ConfirmationCard, { attachTo: document.body, props: { confirmation }, global: { plugins: [createPinia()] } })
    await flushPromises()
    const dialog = document.body.querySelector('.workflow-dialog') as HTMLElement
    expect(dialog.textContent).toContain('需求交付流程')
    expect(dialog.textContent).not.toContain('未发布流程')
    const submit = dialog.querySelector('footer .primary') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    ;(dialog.querySelector('.workflow-option') as HTMLButtonElement).click()
    await flushPromises()
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushPromises()
    expect(wrapper.emitted('resolve')).toEqual([['workflow:wf-published:2']])
    wrapper.unmount()
  })

  it('closes the workflow dialog when the parent resolves the confirmation', async () => {
    const confirmation: ConfirmationCardState = {
      confirmationId: 'select-close', reason: 'select_workflow', title: '选择工作流', description: '选择后开始执行',
      status: 'pending', options: [], workflowOptions: [{
        id: 'wf-published', name: '需求交付流程', version: 2, nodeCount: 1, agentCount: 1,
        humanApprovalCount: 0, robotApprovalCount: 0, status: 'published'
      }]
    }
    const wrapper = mount(ConfirmationCard, {
      attachTo: document.body,
      props: { confirmation },
      global: { plugins: [createPinia()] }
    })
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(1)

    await wrapper.setProps({ confirmation: { ...confirmation, status: 'approved' } })
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(0)
    wrapper.unmount()
  })
})
