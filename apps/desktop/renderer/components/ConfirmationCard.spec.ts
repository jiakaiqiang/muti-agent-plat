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
  it('shows published-node evidence and blocks approval when any Agent is unavailable', async () => {
    const confirmation: ConfirmationCardState = {
      confirmationId: 'mapping-1', reason: 'confirm_workflow_member_mapping', title: '确认邀请 Agent',
      description: '以下 Agent 尚未参与本会话。', status: 'pending', workflowId: 'wf-1', workflowName: '交付流程',
      workflowVersion: 3, options: [{ key: 'approve', label: '邀请并启动', style: 'primary' }, { key: 'decline', label: '取消' }],
      memberGaps: [
        { agentId: 'frontend', agentName: '前端工程师', reason: 'not_participating', canInvite: true, nodes: [{
          nodeId: 'develop', nodeName: '前端开发', nodeType: 'agent', stageDescription: '实现界面', inputContract: ['设计稿'],
          outputContract: ['前端代码'], impact: '未加入则所选流程的「前端开发」节点无法按发布图执行。'
        }] },
        { agentId: 'quality', agentName: '质量工程师', reason: 'disabled', canInvite: false, nodes: [{
          nodeId: 'review', nodeName: '质量审核', nodeType: 'robot_approval', reviewPrompt: '检查交付质量', criteria: ['测试通过'],
          impact: '未加入则所选流程的「质量审核」质量审核节点无法按发布图执行。'
        }] }
      ]
    }
    const wrapper = mount(ConfirmationCard, { props: { confirmation }, global: { plugins: [createPinia()] } })
    expect(wrapper.text()).toContain('交付流程 · v3')
    expect(wrapper.text()).toContain('前端工程师')
    expect(wrapper.text()).toContain('前端代码')
    expect(wrapper.text()).toContain('质量审核')
    expect(wrapper.text()).toContain('测试通过')
    expect(wrapper.text()).toContain('不能只邀请部分成员后启动')
    expect((wrapper.get('.action-button.primary').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('.action-button.default').trigger('click')
    expect(wrapper.emitted('resolve')).toEqual([['decline']])
  })

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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [{ ...published, workflowId: published.id, version: published.currentPublishedVersion }], hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const confirmation: ConfirmationCardState = {
      confirmationId: 'select-1', reason: 'select_workflow', title: '选择工作流', description: '选择后开始执行',
      status: 'pending', options: [], workflowOptions: []
    }
    const wrapper = mount(ConfirmationCard, {
      attachTo: document.body,
      props: { confirmation, autoOpenWorkflowDialog: true },
      global: { plugins: [createPinia()] }
    })
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
      props: { confirmation, autoOpenWorkflowDialog: true },
      global: { plugins: [createPinia()] }
    })
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(1)

    await wrapper.setProps({ confirmation: { ...confirmation, status: 'approved' } })
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps duplicate workflow confirmation cards inline unless one surface owns auto-open', async () => {
    const confirmation: ConfirmationCardState = {
      confirmationId: 'select-single-owner',
      reason: 'select_workflow',
      title: '选择工作流',
      description: '选择后开始执行',
      status: 'pending',
      options: [],
      workflowOptions: []
    }
    const passive = mount(ConfirmationCard, {
      attachTo: document.body,
      props: { confirmation },
      global: { plugins: [createPinia()] }
    })
    const owner = mount(ConfirmationCard, {
      attachTo: document.body,
      props: { confirmation, autoOpenWorkflowDialog: true },
      global: { plugins: [createPinia()] }
    })
    await flushPromises()

    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(1)
    await owner.setProps({ autoOpenWorkflowDialog: false })
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(0)

    await passive.get('.confirmation-card__workflow-selection .primary').trigger('click')
    await flushPromises()
    expect(document.body.querySelectorAll('.workflow-dialog')).toHaveLength(1)
    passive.unmount()
    owner.unmount()
  })
})
