import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UserInputBox, { type ComposerAttachment } from './UserInputBox.vue'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import { useSkillStore } from '@/stores/skill'
import { useAgentStore } from '@/stores/agent'
import type { AgentDefinition, Skill, SkillCategory } from '@/types/contracts'

function makeSkill(input: Pick<Skill, 'id' | 'key' | 'name' | 'categoryId' | 'revision'>): Skill {
  return {
    ...input,
    description: `${input.name} description`,
    content: `${input.name} content`,
    files: [],
    status: 'active',
    scope: 'system',
    scopeId: 'system',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z'
  }
}

function makeCategory(id: string, name: string): SkillCategory {
  return {
    id,
    name,
    scope: 'system',
    scopeId: 'system',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z'
  }
}

function makeAgent(input: Pick<AgentDefinition, 'id' | 'key' | 'name'> & Partial<AgentDefinition>): AgentDefinition {
  return {
    id: input.id,
    key: input.key,
    name: input.name,
    role: input.role ?? input.name,
    description: input.description ?? `${input.name} description`,
    profileMarkdown: input.profileMarkdown ?? `# ${input.name}`,
    tags: input.tags ?? ['工程'],
    status: input.status ?? 'active',
    capabilityIds: input.capabilityIds ?? [],
    defaultKnowledgeBaseIds: input.defaultKnowledgeBaseIds ?? [],
    profileRevision: input.profileRevision ?? 1,
    createdAt: input.createdAt ?? '2026-09-22T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-09-22T00:00:00.000Z',
    management: input.management ?? {
      owner: 'user',
      protected: false,
      allowedSurfaces: ['mention'],
      editableFields: ['name', 'description', 'profileMarkdown']
    }
  }
}

describe('UserInputBox composer context tags', () => {
  beforeEach(() => setActivePinia(createPinia()))

  let wrapper: ReturnType<typeof mount>
  afterEach(() => wrapper?.unmount())

  it('renders image thumbnails, file preview tags, Skill and multiple Agent tags', () => {
    wrapper = mount(UserInputBox, {
      props: {
        attachments: [
          {
            id: 'image-1', sessionId: 'session-1', kind: 'image', fileName: 'brief.png',
            mimeType: 'image/png', sizeBytes: 100, uploadStatus: 'ready', recognitionStatus: 'ready',
            createdAt: '2026-09-22T00:00:00.000Z', previewUrl: 'data:image/png;base64,placeholder',
            recognitionSummary: '包含一个流程图。'
          },
          {
            id: 'file-1', sessionId: 'session-1', kind: 'file', fileName: 'notes.txt',
            mimeType: 'text/plain', sizeBytes: 100, uploadStatus: 'ready',
            createdAt: '2026-09-22T00:00:00.000Z'
          }
        ],
        skill: { id: 'skill-1', key: 'vision', name: '图片理解' },
        agents: [
          { id: 'agent-1', name: '分析 Agent' },
          { id: 'agent-2', name: '审核 Agent' }
        ]
      }
    })

    expect(wrapper.find('.composer-attachment__thumbnail').exists()).toBe(true)
    expect(wrapper.text()).toContain('notes.txt')
    expect(wrapper.text()).toContain('/图片理解')
    expect(wrapper.text()).toContain('@分析 Agent')
    expect(wrapper.text()).toContain('@审核 Agent')
    expect(wrapper.text()).toContain('已识别')
    expect(wrapper.text()).toContain('包含一个流程图。')
  })

  it('shows a retry action for a failed image recognition without making the summary editable', () => {
    wrapper = mount(UserInputBox, {
      props: {
        sessionId: 'session-1',
        attachments: [{
          id: 'image-1', sessionId: 'session-1', kind: 'image', fileName: 'brief.png',
          mimeType: 'image/png', sizeBytes: 100, uploadStatus: 'ready', recognitionStatus: 'failed',
          createdAt: '2026-09-22T00:00:00.000Z'
        }]
      }
    })

    expect(wrapper.text()).toContain('识别失败')
    expect(wrapper.get('[aria-label="重试识别 brief.png"]').exists()).toBe(true)
    expect(wrapper.find('.composer-attachment__summary').exists()).toBe(false)
    expect(wrapper.find('textarea').attributes('readonly')).toBeUndefined()
  })

  it('emits independent remove events for attachments and Tags', async () => {
    wrapper = mount(UserInputBox, {
      props: {
        attachments: [{
          id: 'file-1', sessionId: 'session-1', kind: 'file', fileName: 'notes.txt',
          mimeType: 'text/plain', sizeBytes: 100, uploadStatus: 'ready',
          createdAt: '2026-09-22T00:00:00.000Z'
        }],
        skill: { id: 'skill-1', key: 'vision', name: '图片理解' },
        agents: [{ id: 'agent-1', name: '分析 Agent' }]
      }
    })

    await wrapper.get('[aria-label="删除附件 notes.txt"]').trigger('click')
    await wrapper.get('[aria-label="删除 Skill 图片理解"]').trigger('click')
    await wrapper.get('[aria-label="删除 Agent 分析 Agent"]').trigger('click')

    expect(wrapper.emitted('remove-attachment')).toEqual([['file-1']])
    expect(wrapper.emitted('remove-skill')).toEqual([[]])
    expect(wrapper.emitted('remove-agent')).toEqual([['agent-1']])
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
  })

  it('allows sending an attachment-only draft', async () => {
    wrapper = mount(UserInputBox, {
      props: {
        attachments: [{
          id: 'file-1', sessionId: 'session-1', kind: 'file', fileName: 'notes.txt',
          mimeType: 'text/plain', sizeBytes: 100, uploadStatus: 'ready',
          createdAt: '2026-09-22T00:00:00.000Z', previewUrl: 'data:text/plain;base64,preview',
          sourceFile: new File(['notes'], 'notes.txt', { type: 'text/plain' })
        }]
      }
    })
    useWorkspaceUiStore().messageDraft = ''

    expect(wrapper.get('[aria-label="发送"]').attributes('disabled')).toBeUndefined()
  })

  it('keeps the fifth image out of the draft and exposes a visible limit error', async () => {
    wrapper = mount(UserInputBox)
    const vm = wrapper.vm as unknown as { addAttachment: (attachment: ComposerAttachment) => boolean }
    const attachment = (id: string): ComposerAttachment => ({
      id, sessionId: 'session-1', kind: 'image', fileName: `${id}.png`, mimeType: 'image/png',
      sizeBytes: 100, uploadStatus: 'ready', recognitionStatus: 'ready', createdAt: '2026-09-22T00:00:00.000Z'
    })

    for (let index = 1; index <= 4; index += 1) expect(vm.addAttachment(attachment(`image-${index}`))).toBe(true)
    expect(vm.addAttachment(attachment('image-5'))).toBe(false)
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.composer-attachment')).toHaveLength(4)
    expect(wrapper.get('[role="alert"]').text()).toContain('最多上传 4 张图片')

    for (let index = 1; index <= 4; index += 1) {
      expect(vm.addAttachment({
        id: `file-${index}`, sessionId: 'session-1', kind: 'file', fileName: `${index}.txt`, mimeType: 'text/plain',
        sizeBytes: 100, uploadStatus: 'ready', createdAt: '2026-09-22T00:00:00.000Z'
      })).toBe(true)
    }
    expect(vm.addAttachment({
      id: 'file-5', sessionId: 'session-1', kind: 'file', fileName: '5.txt', mimeType: 'text/plain',
      sizeBytes: 100, uploadStatus: 'ready', createdAt: '2026-09-22T00:00:00.000Z'
    })).toBe(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="alert"]').text()).toContain('最多上传 4 个文件')
  })

  it('mutates the real draft state when a locally added file is removed', async () => {
    wrapper = mount(UserInputBox)
    const vm = wrapper.vm as unknown as {
      addAttachment: (attachment: ComposerAttachment) => boolean
      removeAttachment: (attachmentId: string) => void
    }
    expect(vm.addAttachment({
      id: 'draft-file', sessionId: 'session-1', kind: 'file', fileName: 'draft.txt', mimeType: 'text/plain',
      sizeBytes: 100, uploadStatus: 'ready', createdAt: '2026-09-22T00:00:00.000Z'
    })).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('draft.txt')
    vm.removeAttachment('draft-file')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('draft.txt')
    expect(wrapper.emitted('context-change')?.at(-1)?.[0]).toMatchObject({ attachments: [] })
  })

  it('blocks a second Skill but supports explicit replacement and multiple Agents', async () => {
    wrapper = mount(UserInputBox)
    const vm = wrapper.vm as unknown as {
      selectSkill: (skill: { id: string; key: string; name: string }) => boolean
      replaceSkill: (skill: { id: string; key: string; name: string }) => void
      selectAgent: (agent: { id: string; name: string }) => boolean
    }
    const firstSkill = { id: 'skill-1', key: 'vision', name: '图片理解' }
    const secondSkill = { id: 'skill-2', key: 'review', name: '审核' }

    expect(vm.selectSkill(firstSkill)).toBe(true)
    expect(vm.selectSkill(secondSkill)).toBe(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="alert"]').text()).toContain('只能选择一个 Skill')
    expect(vm.selectAgent({ id: 'agent-1', name: '分析 Agent' })).toBe(true)
    expect(vm.selectAgent({ id: 'agent-2', name: '审核 Agent' })).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('/图片理解')
    expect(wrapper.text()).toContain('@分析 Agent')
    expect(wrapper.text()).toContain('@审核 Agent')

    vm.replaceSkill(secondSkill)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('/图片理解')
    expect(wrapper.text()).toContain('/审核')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('rejects unresolved @ text while allowing a literal slash message', async () => {
    wrapper = mount(UserInputBox)
    const store = useWorkspaceUiStore()
    store.messageDraft = '请查看 @'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[aria-label="发送"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('选择 Agent')

    store.messageDraft = '请检查 /tmp/log.txt'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[aria-label="发送"]').attributes('disabled')).toBeUndefined()
  })

  it('keeps the input and context Tags keyboard/accessibility distinguishable', async () => {
    wrapper = mount(UserInputBox, {
      props: { skill: { id: 'skill-1', key: 'vision', name: '图片理解' }, agents: [{ id: 'agent-1', name: '分析 Agent' }] }
    })
    expect(wrapper.get('label[for="group-chat-message-input"]').text()).toBe('消息输入')
    expect(wrapper.get('.composer-tag--skill').classes()).toContain('composer-tag--skill')
    expect(wrapper.get('.composer-tag--agent').classes()).toContain('composer-tag--agent')
    expect(wrapper.get('[aria-label="删除 Skill 图片理解"]').attributes('type')).toBe('button')
    expect(wrapper.get('[aria-label="删除 Agent 分析 Agent"]').attributes('type')).toBe('button')
  })

  it('emits a structured context event for an attachment-only message', async () => {
    wrapper = mount(UserInputBox, {
      props: {
        attachments: [{
          id: 'file-1', sessionId: 'session-1', kind: 'file', fileName: 'notes.txt',
          mimeType: 'text/plain', sizeBytes: 100, uploadStatus: 'ready',
          createdAt: '2026-09-22T00:00:00.000Z'
        }]
      }
    })

    await wrapper.get('[aria-label="发送"]').trigger('click')
    const context = wrapper.emitted('send-context')?.[0]?.[0] as { text: string; directives: { attachments: Array<{ id: string }> } }
    expect(context.text).toBe('')
    expect(context.directives.attachments.map(item => item.id)).toEqual(['file-1'])
    expect(context.directives.attachments[0]).not.toHaveProperty('previewUrl')
    expect(context.directives.attachments[0]).not.toHaveProperty('sourceFile')
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
  })

  it('opens the categorized authorized Skill picker and emits a versioned Skill tag', async () => {
    const skillStore = useSkillStore()
    const skills = [
      makeSkill({ id: 'skill-beta', key: 'beta', name: 'Beta Skill', categoryId: 'cat-b', revision: 2 }),
      makeSkill({ id: 'skill-alpha', key: 'alpha', name: 'Alpha Skill', categoryId: 'cat-a', revision: 4 })
    ]
    const categories = [makeCategory('cat-b', 'Beta'), makeCategory('cat-a', 'Alpha')]
    vi.spyOn(skillStore, 'loadAvailableSkills').mockResolvedValue(skills)
    vi.spyOn(skillStore, 'loadAvailableCategories').mockResolvedValue(categories)

    wrapper = mount(UserInputBox)
    useWorkspaceUiStore().messageDraft = '/'
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="listbox"]').exists()).toBe(true)
    expect(wrapper.findAll('.skill-picker__category').map(node => node.text())).toEqual(['Alpha', 'Beta'])
    expect(wrapper.find('input[type="search"]').exists()).toBe(false)
    await wrapper.get('[data-testid="skill-picker-option-skill-alpha"]').trigger('click')

    expect(wrapper.text()).toContain('/Alpha Skill')
    expect(useWorkspaceUiStore().messageDraft).toBe('')
    expect(wrapper.emitted('context-change')?.at(-1)?.[0]).toMatchObject({
      skills: [{ id: 'skill-alpha', key: 'alpha', name: 'Alpha Skill', revision: 4 }]
    })
  })

  it('supports keyboard selection, Escape dismissal, and keeps ordinary slash text literal', async () => {
    const skillStore = useSkillStore()
    const skills = [makeSkill({ id: 'skill-one', key: 'one', name: 'One Skill', categoryId: 'cat-a', revision: 1 })]
    vi.spyOn(skillStore, 'loadAvailableSkills').mockResolvedValue(skills)
    vi.spyOn(skillStore, 'loadAvailableCategories').mockResolvedValue([makeCategory('cat-a', 'Alpha')])

    wrapper = mount(UserInputBox)
    const store = useWorkspaceUiStore()
    store.messageDraft = '/'
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.text()).toContain('/One Skill')

    wrapper = mount(UserInputBox)
    store.messageDraft = '/'
    await wrapper.vm.$nextTick()
    await wrapper.get('textarea').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(store.messageDraft).toBe('/')

    store.messageDraft = '/path/to/file'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('closes the picker after a second Skill attempt and emits the existing single-Skill error', async () => {
    const skillStore = useSkillStore()
    const second = makeSkill({ id: 'skill-second', key: 'second', name: 'Second Skill', categoryId: 'cat-a', revision: 3 })
    vi.spyOn(skillStore, 'loadAvailableSkills').mockResolvedValue([second])
    vi.spyOn(skillStore, 'loadAvailableCategories').mockResolvedValue([makeCategory('cat-a', 'Alpha')])

    wrapper = mount(UserInputBox, { props: { skill: { id: 'skill-first', key: 'first', name: 'First Skill', revision: 1 } } })
    useWorkspaceUiStore().messageDraft = '/'
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="skill-picker-option-skill-second"]').trigger('click')

    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('只能选择一个 Skill')
    expect(wrapper.emitted('select-skill-blocked')).toHaveLength(1)
  })

  it('loads mention Agents from management data, filters the main/disabled entries, and searches grouped results', async () => {
    const agentStore = useAgentStore()
    const agents = [
      makeAgent({ id: 'agent-main', key: 'coordinator', name: '主 Agent', tags: ['系统'] }),
      makeAgent({ id: 'agent-disabled', key: 'disabled', name: '停用 Agent', status: 'disabled' }),
      makeAgent({ id: 'agent-hidden', key: 'hidden', name: '不可用 Agent', management: { owner: 'user', protected: false, allowedSurfaces: ['chat'], editableFields: ['name'] } }),
      makeAgent({ id: 'agent-review', key: 'review', name: '审核 Agent', description: '检查发布风险', tags: ['审核'] }),
      makeAgent({ id: 'agent-build', key: 'build', name: '构建 Agent', tags: ['工程'] })
    ]
    vi.spyOn(agentStore, 'loadAgentsForSurface').mockResolvedValue(agents)

    wrapper = mount(UserInputBox, { props: { memberAgentIds: ['agent-review', 'agent-build'] } })
    const store = useWorkspaceUiStore()
    store.messageDraft = '@'
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="listbox"]').attributes('aria-label')).toBe('选择 Agent')
    expect(wrapper.findAll('.agent-picker__option').map(node => node.text())).toEqual(['@构建 Agent构建 Agent description', '@审核 Agent检查发布风险'])
    expect(wrapper.text()).not.toContain('@主 Agent')
    expect(wrapper.text()).not.toContain('@停用 Agent')
    expect(wrapper.text()).not.toContain('@不可用 Agent')

    store.messageDraft = '@风险'
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.agent-picker__option').map(node => node.text())).toEqual(['@审核 Agent检查发布风险'])
    await wrapper.get('[data-testid="agent-picker-option-agent-review"]').trigger('click')
    expect(wrapper.text()).toContain('@审核 Agent')
    expect(wrapper.emitted('context-change')?.at(-1)?.[0]).toMatchObject({ agents: [{ id: 'agent-review', key: 'review' }] })
  })

  it('requires confirmation before adding an Agent outside the current group and keeps duplicate additions idempotent', async () => {
    const agentStore = useAgentStore()
    const external = makeAgent({ id: 'agent-external', key: 'external', name: '外部 Agent', tags: ['研究'] })
    vi.spyOn(agentStore, 'loadAgentsForSurface').mockResolvedValue([external])

    wrapper = mount(UserInputBox, { props: { memberAgentIds: [] } })
    const store = useWorkspaceUiStore()
    store.messageDraft = '@外部'
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="agent-picker-option-agent-external"]').trigger('click')

    expect(wrapper.get('[role="dialog"]').text()).toContain('尚未加入当前群聊')
    expect(wrapper.find('.composer-tag--agent').exists()).toBe(false)
    await wrapper.get('.agent-join-confirm__cancel').trigger('click')
    expect(wrapper.emitted('agent-join-cancelled')).toHaveLength(1)
    expect(wrapper.find('.composer-tag--agent').exists()).toBe(false)

    await (wrapper.vm as unknown as { openAgentPicker: () => Promise<void> }).openAgentPicker()
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="agent-picker-option-agent-external"]').trigger('click')
    await wrapper.get('.agent-join-confirm__accept').trigger('click')
    expect(wrapper.findAll('.composer-tag--agent')).toHaveLength(1)
    expect(wrapper.emitted('agent-join-confirmed')).toHaveLength(1)
    const vm = wrapper.vm as unknown as { selectAgent: (agent: { id: string; name: string }) => boolean }
    expect(vm.selectAgent({ id: 'agent-external', name: '外部 Agent' })).toBe(false)
    expect(wrapper.findAll('.composer-tag--agent')).toHaveLength(1)
  })
})
