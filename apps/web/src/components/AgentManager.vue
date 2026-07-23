<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAgentStore, type AgentFormState } from '@/stores/agent'
import { useSkillStore } from '@/stores/skill'
import type { AgentDefinition, CapabilityDefinition } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  agents: AgentDefinition[]
  capabilities: CapabilityDefinition[]
}>()

const agentStore = useAgentStore()
const skillStore = useSkillStore()

const editorRef = ref<HTMLTextAreaElement | null>(null)
const {
  showCreateForm,
  editingAgentId,
  savingAgentId,
  formError,
  resourceSearch,
  previewMode,
  diagnostics,
  compiled,
  validating,
  selectedAgentId,
  agentSearch,
  activeTab,
  profilePanelOpen,
  canvasLayout,
  selectedResourceKey,
  libraryCollapsed,
  createForm,
  editForms
} = storeToRefs(agentStore)

const activeAgentCount = computed(() => props.agents.filter((agent) => agent.status === 'active').length)
const capabilityNameById = computed(() => new Map(props.capabilities.map((capability) => [capability.id, capability.name])))
const activeForm = computed<AgentFormState | null>(() => {
  if (showCreateForm.value) return createForm.value
  if (editingAgentId.value) return editForms.value[editingAgentId.value] ?? null
  return null
})
const selectedAgent = computed(() => props.agents.find((agent) => agent.id === selectedAgentId.value))
const filteredAgents = computed(() => {
  const q = agentSearch.value.trim().toLowerCase()
  return props.agents.filter(
    (agent) =>
      !q ||
      agent.name.toLowerCase().includes(q) ||
      agent.role.toLowerCase().includes(q) ||
      agent.tags.some((tag) => tag.toLowerCase().includes(q))
  )
})

// Profile 支持 ${skill:key}；只有非 internal 的 Tool 才允许 ${tool:key} 引用。
const insertableTools = computed(() => props.capabilities.filter((capability) => capability.kind !== 'internal'))

const filteredSkills = computed(() => {
  const q = resourceSearch.value.trim().toLowerCase()
  return skillStore.skills.filter(
    (skill) => !q || skill.name.toLowerCase().includes(q) || (skill.key ?? '').toLowerCase().includes(q)
  )
})
const filteredTools = computed(() => {
  const q = resourceSearch.value.trim().toLowerCase()
  return insertableTools.value.filter(
    (tool) => !q || tool.name.toLowerCase().includes(q) || tool.key.toLowerCase().includes(q)
  )
})

type CanvasResource = {
  id: string
  key: string
  name: string
  description: string
  kind: 'skill' | 'tool'
  sourceKind?: CapabilityDefinition['kind'] | 'skill'
  status: string
  tone: number
  capabilityId?: string
}

const canvasResources = computed<CanvasResource[]>(() => {
  const form = activeForm.value
  const markdown = form?.profileMarkdown ?? selectedAgent.value?.profileMarkdown ?? ''
  const references = Array.from(markdown.matchAll(/\$\{(skill|tool):([^}]+)\}/g))
  const resources: CanvasResource[] = []
  const seen = new Set<string>()

  references.forEach((match, index) => {
    const kind = match[1] as 'skill' | 'tool'
    const key = match[2]
    const resourceKey = `${kind}:${key}`
    if (seen.has(resourceKey)) return
    seen.add(resourceKey)
    if (kind === 'skill') {
      const skill = skillStore.skills.find((item) => item.key === key)
      resources.push({
        id: skill?.id ?? resourceKey,
        key,
        name: skill?.name ?? key,
        description: skill?.description || summarizeMarkdown(skill?.content ?? '可复用的专业工作规则'),
        kind,
        sourceKind: 'skill',
        status: skill?.status === 'disabled' ? '停用' : 'Skill',
        tone: (index % 4) + 1
      })
      return
    }
    const tool = insertableTools.value.find((item) => item.key === key)
    resources.push({
      id: tool?.id ?? resourceKey,
      key,
      name: tool?.name ?? key,
      description: summarizeMarkdown(tool?.descriptionMarkdown ?? '受控工具能力'),
      kind,
      sourceKind: tool?.kind ?? 'tool',
      status: tool?.riskLevel === 'high' ? '高风险' : 'Tool',
      tone: (index % 4) + 1,
      capabilityId: tool?.id
    })
  })

  const capabilityIds = form?.capabilityIds ?? selectedAgent.value?.capabilityIds ?? []
  capabilityIds.forEach((capabilityId, index) => {
    const tool = props.capabilities.find((item) => item.id === capabilityId)
    if (!tool || seen.has(`tool:${tool.key}`)) return
    seen.add(`tool:${tool.key}`)
    resources.push({
      id: tool.id,
      key: tool.key,
      name: tool.name,
      description: summarizeMarkdown(tool.descriptionMarkdown ?? '受控工具能力'),
      kind: 'tool',
      sourceKind: tool.kind,
      status: tool.kind === 'internal' ? '内置' : tool.riskLevel === 'high' ? '高风险' : 'Tool',
      tone: ((resources.length + index) % 4) + 1,
      capabilityId: tool.id
    })
  })
  return resources.slice(0, 8)
})

const selectedResource = computed(() => {
  return canvasResources.value.find((resource) => `${resource.kind}:${resource.key}` === selectedResourceKey.value)
})

const detailResource = computed<CanvasResource | null>(() => {
  if (selectedResource.value) return selectedResource.value
  return canvasResources.value[0] ?? null
})

function emptyForm(): AgentFormState {
  return {
    name: '',
    tags: '',
    profileMarkdown: '# 新 Agent\n\n## 工作职责\n\n描述该 Agent 的职责。\n\n## 专项技能\n\n## 可用工具\n',
    capabilityIds: []
  }
}

function formFromAgent(agent: AgentDefinition): AgentFormState {
  return {
    name: agent.name,
    tags: agent.tags?.join(', ') ?? '',
    profileMarkdown: agent.profileMarkdown ?? `# ${agent.name}\n\n${agent.role}`,
    capabilityIds: [...agent.capabilityIds]
  }
}

function normalizedTags(tags: string) {
  return Array.from(new Set(tags.split(/[,\n\s]+/).map((tag) => tag.trim()).filter(Boolean)))
}

function statusLabel(status: AgentDefinition['status']) {
  return status === 'active' ? '启用中' : '已停用'
}

function capabilityLabel(capabilityId: string) {
  return capabilityNameById.value.get(capabilityId) ?? capabilityId
}

function summarizeMarkdown(markdown: string) {
  return (
    markdown
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
      .find(Boolean) ?? '已配置能力'
  ).slice(0, 48)
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

function selectAgent(agent: AgentDefinition) {
  selectedAgentId.value = agent.id
  selectedResourceKey.value = ''
  activeTab.value = 'edit'
  profilePanelOpen.value = false
  startEdit(agent)
}

function beginCreate() {
  selectedAgentId.value = ''
  selectedResourceKey.value = ''
  activeTab.value = 'edit'
  profilePanelOpen.value = true
  startCreate()
}

function openProfileEditor() {
  if (!activeForm.value && selectedAgent.value) startEdit(selectedAgent.value)
  profilePanelOpen.value = true
}

async function addResource(kind: 'skill' | 'tool', key: string, capabilityId?: string) {
  if (!activeForm.value && selectedAgent.value) {
    startEdit(selectedAgent.value)
    await nextTick()
  }
  insertReference(kind, key, capabilityId)
  selectedResourceKey.value = `${kind}:${key}`
}

function selectResource(kind: 'skill' | 'tool', key: string) {
  selectedResourceKey.value = `${kind}:${key}`
}

function removeCanvasResource(resource: CanvasResource) {
  const form = activeForm.value
  if (!form) return
  const placeholder = `\${${resource.kind}:${resource.key}}`
  form.profileMarkdown = form.profileMarkdown
    .split('\n')
    .filter((line) => line.trim() !== placeholder)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  if (resource.kind === 'tool' && resource.capabilityId) {
    form.capabilityIds = form.capabilityIds.filter((id) => id !== resource.capabilityId)
  }
  selectedResourceKey.value = ''
  void revalidate()
}

function clearCanvas() {
  const form = activeForm.value
  if (!form) return
  form.profileMarkdown = form.profileMarkdown
    .split('\n')
    .filter((line) => !/^\$\{(?:skill|tool):[^}]+\}$/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  form.capabilityIds = []
  selectedResourceKey.value = ''
  void revalidate()
}

function insertReference(kind: 'skill' | 'tool', key: string, capabilityId?: string) {
  const form = activeForm.value
  if (!form) return
  const placeholder = `\${${kind}:${key}}`
  const textarea = editorRef.value
  if (textarea && document.activeElement === textarea) {
    const start = textarea.selectionStart ?? form.profileMarkdown.length
    const end = textarea.selectionEnd ?? start
    form.profileMarkdown = form.profileMarkdown.slice(0, start) + placeholder + form.profileMarkdown.slice(end)
  } else {
    form.profileMarkdown = insertIntoSection(form.profileMarkdown, kind, placeholder)
  }
  // Tool 选择同时补充 capabilityIds（保存时仍由后端校验）。
  if (kind === 'tool' && capabilityId && !form.capabilityIds.includes(capabilityId)) {
    form.capabilityIds = [...form.capabilityIds, capabilityId]
  }
  void revalidate()
}

function insertIntoSection(markdown: string, kind: 'skill' | 'tool', placeholder: string) {
  const heading = kind === 'skill' ? '## 专项技能' : '## 可用工具'
  const lines = markdown.split('\n')
  const idx = lines.findIndex((line) => line.trim() === heading)
  if (idx === -1) {
    return `${markdown.trimEnd()}\n\n${heading}\n\n${placeholder}\n`
  }
  // 插入到该 section 标题下一行
  lines.splice(idx + 1, 0, '', placeholder)
  return lines.join('\n')
}

function onDropReference(event: DragEvent) {
  const raw = event.dataTransfer?.getData('text/reference')
  if (!raw) return
  event.preventDefault()
  const [kind, key, capabilityId] = raw.split('|')
  insertReference(kind as 'skill' | 'tool', key, capabilityId || undefined)
}

function onDragStart(event: DragEvent, kind: 'skill' | 'tool', key: string, capabilityId?: string) {
  event.dataTransfer?.setData('text/reference', `${kind}|${key}|${capabilityId ?? ''}`)
}

let revalidateTimer: ReturnType<typeof setTimeout> | null = null
function revalidate() {
  if (revalidateTimer) clearTimeout(revalidateTimer)
  revalidateTimer = setTimeout(async () => {
    const form = activeForm.value
    if (!form) return
    validating.value = true
    try {
      const result = await agentStore.validateProfile({
        profileMarkdown: form.profileMarkdown,
        capabilityIds: form.capabilityIds
      })
      compiled.value = result
      diagnostics.value = result.diagnostics
    } catch (error) {
      diagnostics.value = [
        { severity: 'error', code: 'unknown_skill', message: error instanceof Error ? error.message : '校验失败' }
      ]
    } finally {
      validating.value = false
    }
  }, 250)
}

watch(
  () => activeForm.value?.profileMarkdown,
  () => {
    if (activeForm.value) void revalidate()
  }
)

function startCreate() {
  createForm.value = emptyForm()
  formError.value = ''
  diagnostics.value = []
  compiled.value = null
  showCreateForm.value = true
  editingAgentId.value = ''
  void revalidate()
}

function cancelCreate() {
  showCreateForm.value = false
  createForm.value = emptyForm()
  formError.value = ''
  profilePanelOpen.value = false
  const first = props.agents[0]
  if (first) selectAgent(first)
}

function startEdit(agent: AgentDefinition) {
  editForms.value = { ...editForms.value, [agent.id]: formFromAgent(agent) }
  formError.value = ''
  diagnostics.value = []
  compiled.value = null
  editingAgentId.value = agent.id
  showCreateForm.value = false
  void revalidate()
}

function cancelEdit() {
  if (selectedAgent.value) {
    editForms.value = { ...editForms.value, [selectedAgent.value.id]: formFromAgent(selectedAgent.value) }
    editingAgentId.value = selectedAgent.value.id
  } else {
    editingAgentId.value = ''
  }
  formError.value = ''
  profilePanelOpen.value = false
}

const hasBlockingErrors = computed(() => diagnostics.value.some((d) => d.severity === 'error'))

async function createAgent() {
  const name = createForm.value.name.trim()
  if (!name) {
    formError.value = '请填写 Agent 名称'
    return
  }
  if (hasBlockingErrors.value) {
    formError.value = '存在无效引用，请先修复后再保存'
    return
  }
  savingAgentId.value = 'new'
  formError.value = ''
  try {
    await agentStore.createAgent({
      name,
      role: firstParagraph(createForm.value.profileMarkdown) || name,
      tags: normalizedTags(createForm.value.tags),
      profileMarkdown: createForm.value.profileMarkdown,
      capabilityIds: createForm.value.capabilityIds
    })
    cancelCreate()
  } catch (error) {
    formError.value = extractError(error)
  } finally {
    savingAgentId.value = ''
  }
}

async function updateAgent(agent: AgentDefinition) {
  const form = editForms.value[agent.id]
  if (!form) return
  const name = form.name.trim()
  if (!name) {
    formError.value = '请填写 Agent 名称'
    return
  }
  if (hasBlockingErrors.value) {
    formError.value = '存在无效引用，请先修复后再保存'
    return
  }
  savingAgentId.value = agent.id
  formError.value = ''
  try {
    await agentStore.updateAgent(agent.id, {
      name,
      role: firstParagraph(form.profileMarkdown) || name,
      tags: normalizedTags(form.tags),
      profileMarkdown: form.profileMarkdown,
      capabilityIds: form.capabilityIds
    })
    profilePanelOpen.value = false
  } catch (error) {
    formError.value = extractError(error)
  } finally {
    savingAgentId.value = ''
  }
}

function firstParagraph(markdown: string) {
  return (
    markdown
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) ?? ''
  ).slice(0, 200)
}

function extractError(error: unknown) {
  if (error instanceof Error) return error.message
  return '保存 Agent 失败'
}

async function toggleAgentStatus(agent: AgentDefinition) {
  savingAgentId.value = agent.id
  formError.value = ''
  try {
    await agentStore.updateAgent(agent.id, { status: agent.status === 'active' ? 'disabled' : 'active' })
  } catch (error) {
    formError.value = extractError(error)
  } finally {
    savingAgentId.value = ''
  }
}

onMounted(async () => {
  if (!skillStore.skills.length) {
    await skillStore.loadSkills().catch(() => undefined)
  }
})

watch(
  () => props.agents,
  (agents) => {
    if (showCreateForm.value) return
    const selected = agents.find((agent) => agent.id === selectedAgentId.value)
    if (!selected && agents[0]) selectAgent(agents[0])
  },
  { immediate: true }
)
</script>

<template>
  <div class="agent-manager">
    <header class="agent-page-head">
      <div class="agent-page-title">
        <span class="agent-page-logo"><UiIcon name="bot" :size="23" /></span>
        <div>
          <h1>Agent 能力编排</h1>
          <p>通过 Skill 和 Tool 组合 Agent 能力，构建职责清晰、边界可控的智能体</p>
        </div>
      </div>
      <div class="agent-page-summary">
        <dl>
          <div><dt>总数</dt><dd>{{ agents.length }}</dd></div>
          <div><dt>启用</dt><dd>{{ activeAgentCount }}</dd></div>
        </dl>
        <i aria-hidden="true"></i>
        <button type="button" class="agent-primary" @click="beginCreate"><UiIcon name="plus" :size="16" />新建 Agent</button>
      </div>
    </header>

    <div class="agent-page-body">
      <aside class="agent-directory" aria-label="Agent 列表">
        <h2>Agent 列表</h2>
        <label class="agent-search"><UiIcon name="search" :size="16" /><input v-model="agentSearch" type="search" aria-label="搜索 Agent 名称" placeholder="搜索 Agent 名称" /></label>
        <div class="agent-directory-list">
          <button v-for="(agent, index) in filteredAgents" :key="agent.id" type="button" :class="['agent-row', { selected: agent.id === selectedAgentId }]" @click="selectAgent(agent)">
            <span :class="['agent-row-icon', `tone-${(index % 5) + 1}`]"><UiIcon :name="index % 3 === 1 ? 'workflow' : index % 3 === 2 ? 'sparkles' : 'bot'" :size="18" /></span>
            <span><strong>{{ agent.name }}</strong><small>v{{ agent.profileRevision }}　{{ formatUpdatedAt(agent.updatedAt) }}</small></span>
            <em :class="agent.status">{{ agent.status === 'active' ? '启用' : '停用' }}</em>
          </button>
          <p v-if="!filteredAgents.length">未找到匹配的 Agent</p>
        </div>
        <button type="button" class="agent-directory-create" @click="beginCreate"><UiIcon name="plus" :size="15" />新建 Agent</button>
      </aside>

      <main v-if="selectedAgent || showCreateForm" class="agent-designer">
        <header class="agent-designer-top">
          <div class="agent-current"><span><UiIcon name="sparkles" :size="18" /></span><strong>{{ showCreateForm ? activeForm?.name || '新 Agent' : selectedAgent?.name }}</strong><button type="button" title="编辑 Agent 资料" @click="openProfileEditor"><UiIcon name="settings" :size="14" /></button></div>
          <nav aria-label="Agent 管理视图">
            <button type="button" :class="{ active: activeTab === 'edit' }" @click="activeTab = 'edit'">编辑</button>
            <button type="button" :class="{ active: activeTab === 'config' }" @click="activeTab = 'config'">配置</button>
            <button type="button" :class="{ active: activeTab === 'test' }" @click="activeTab = 'test'">测试</button>
            <button type="button" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">日志</button>
            <button type="button" :class="{ active: activeTab === 'versions' }" @click="activeTab = 'versions'">版本</button>
          </nav>
        </header>

        <section class="designer-heading">
          <div><h2>{{ activeTab === 'edit' ? '能力编排' : activeTab === 'config' ? '运行配置' : activeTab === 'test' ? 'Profile 测试' : activeTab === 'logs' ? '变更日志' : '版本记录' }}</h2><p v-if="activeTab === 'edit'">组合 Skills 与 Tools，定义 Agent 的专业能力与执行边界</p></div>
          <div class="designer-actions">
            <button type="button" @click="openProfileEditor"><UiIcon name="settings" :size="15" />资料设置</button>
            <button type="button" @click="canvasLayout = canvasLayout === 'linear' ? 'branch' : 'linear'"><UiIcon name="workflow" :size="15" />自动布局</button>
            <i></i>
            <button type="button" :disabled="!canvasResources.length" @click="clearCanvas"><UiIcon name="trash" :size="15" />清空画布</button>
            <i></i>
            <button type="button" class="save" :disabled="hasBlockingErrors || Boolean(savingAgentId)" @click="showCreateForm ? createAgent() : selectedAgent ? updateAgent(selectedAgent) : undefined">{{ savingAgentId ? '保存中' : '保存编排' }}</button>
          </div>
        </section>

        <div v-if="activeTab === 'edit'" class="designer-grid">
          <aside class="resource-library" aria-label="能力资源库">
            <section class="resource-group">
              <header><h3><UiIcon name="sparkles" :size="16" />Skills</h3><button type="button" :aria-expanded="!libraryCollapsed.skill" title="展开或收起 Skills" @click="libraryCollapsed.skill = !libraryCollapsed.skill"><UiIcon name="chevron" :size="14" /></button></header>
              <template v-if="!libraryCollapsed.skill">
                <div class="resource-search"><label><UiIcon name="search" :size="15" /><input v-model="resourceSearch" type="search" aria-label="搜索 Skills" placeholder="搜索 Skills" /></label><button type="button" title="添加首个 Skill" :disabled="!filteredSkills.length" @click="filteredSkills[0] && addResource('skill', filteredSkills[0].key ?? '')"><UiIcon name="plus" :size="16" /></button><button type="button" title="清除筛选" @click="resourceSearch = ''"><UiIcon name="filter" :size="16" /></button></div>
                <ul class="resource-items">
                  <li v-for="(skill, index) in filteredSkills" :key="skill.id" draggable="true" @dragstart="onDragStart($event, 'skill', skill.key ?? '')">
                    <button type="button" class="resource-main" @click="selectResource('skill', skill.key ?? '')"><span :class="`tone-${(index % 4) + 1}`"><UiIcon name="sparkles" :size="15" /></span><span><strong>{{ skill.name }}</strong><small>{{ skill.description || summarizeMarkdown(skill.content) }}</small></span></button>
                    <em>{{ skill.status === 'disabled' ? '停用' : '分析' }}</em><button type="button" title="添加到画布" @click="addResource('skill', skill.key ?? '')"><UiIcon name="plus" :size="15" /></button>
                  </li>
                  <li v-if="!filteredSkills.length" class="empty">暂无 Skill</li>
                </ul>
              </template>
            </section>

            <section class="resource-group">
              <header><h3><UiIcon name="settings" :size="16" />Tools</h3><button type="button" :aria-expanded="!libraryCollapsed.tool" title="展开或收起 Tools" @click="libraryCollapsed.tool = !libraryCollapsed.tool"><UiIcon name="chevron" :size="14" /></button></header>
              <template v-if="!libraryCollapsed.tool">
                <div class="resource-search"><label><UiIcon name="search" :size="15" /><input v-model="resourceSearch" type="search" aria-label="搜索 Tools" placeholder="搜索 Tools" /></label><button type="button" title="添加首个 Tool" :disabled="!filteredTools.length" @click="filteredTools[0] && addResource('tool', filteredTools[0].key, filteredTools[0].id)"><UiIcon name="plus" :size="16" /></button><button type="button" title="清除筛选" @click="resourceSearch = ''"><UiIcon name="filter" :size="16" /></button></div>
                <ul class="resource-items">
                  <li v-for="(tool, index) in filteredTools" :key="tool.id" draggable="true" @dragstart="onDragStart($event, 'tool', tool.key, tool.id)">
                    <button type="button" class="resource-main" @click="selectResource('tool', tool.key)"><span :class="`tone-${((index + 1) % 4) + 1}`"><UiIcon name="settings" :size="15" /></span><span><strong>{{ tool.name }}</strong><small>{{ summarizeMarkdown(tool.descriptionMarkdown || tool.usageMarkdown || tool.key) }}</small></span></button>
                    <em>{{ tool.riskLevel === 'high' ? '高风险' : '工具' }}</em><button type="button" title="添加到画布" @click="addResource('tool', tool.key, tool.id)"><UiIcon name="plus" :size="15" /></button>
                  </li>
                  <li v-if="!filteredTools.length" class="empty">暂无可用 Tool</li>
                </ul>
              </template>
            </section>
          </aside>

          <section :class="['capability-canvas', `layout-${canvasLayout}`]" @drop="onDropReference" @dragover.prevent>
            <div class="canvas-flow">
              <div class="flow-terminal start"><span></span>开始</div>
              <button type="button" class="flow-add" title="从资源库添加能力"><UiIcon name="plus" :size="13" /></button>
              <template v-for="resource in canvasResources" :key="`${resource.kind}:${resource.key}`">
                <article :class="['flow-node', `tone-${resource.tone}`, { selected: selectedResourceKey === `${resource.kind}:${resource.key}` }]" @click="selectResource(resource.kind, resource.key)">
                  <span class="flow-node-icon"><UiIcon :name="resource.kind === 'skill' ? 'sparkles' : 'settings'" :size="16" /></span><span class="flow-node-copy"><strong>{{ resource.name }}</strong><small>{{ resource.description }}</small></span><em>{{ resource.status }}</em><button type="button" title="移除能力" @click.stop="removeCanvasResource(resource)"><UiIcon name="x" :size="14" /></button>
                </article>
                <button type="button" class="flow-add" title="添加下一项能力"><UiIcon name="plus" :size="13" /></button>
              </template>
              <div v-if="!canvasResources.length" class="canvas-empty"><span><UiIcon name="workflow" :size="22" /></span><strong>尚未编排能力</strong><small>从资源库选择 Skill 或 Tool</small></div>
              <div class="flow-terminal end"><span></span>结束</div>
            </div>
            <div class="canvas-toolbar"><button type="button" title="适应画布"><UiIcon name="workflow" :size="15" /></button><button type="button" title="缩小">−</button><strong>100%</strong><button type="button" title="放大">＋</button><button type="button" title="锁定画布"><UiIcon name="settings" :size="15" /></button></div>
          </section>

          <aside class="capability-detail">
            <header><h3>能力详情</h3><button type="button" title="清除选择" @click="selectedResourceKey = ''"><UiIcon name="x" :size="14" /></button></header>
            <template v-if="detailResource">
              <div class="detail-identity"><span :class="`tone-${detailResource.tone}`"><UiIcon :name="detailResource.kind === 'skill' ? 'sparkles' : 'settings'" :size="18" /></span><div><strong>{{ detailResource.name }}</strong><em>{{ detailResource.status }}</em><small>{{ detailResource.kind === 'skill' ? '专业工作规则' : detailResource.sourceKind === 'internal' ? '平台内置能力' : '受控执行工具' }}</small></div></div>
              <section><h4>描述</h4><p>{{ detailResource.description }}</p></section>
              <section><h4>能力</h4><ul><li><UiIcon name="check" :size="13" />{{ detailResource.kind === 'skill' ? '上下文规则注入' : detailResource.sourceKind === 'internal' ? '平台能力绑定' : '运行时能力授权' }}</li><li><UiIcon name="check" :size="13" />可追踪引用</li><li><UiIcon name="check" :size="13" />Profile 编译校验</li></ul></section>
              <section><h4>输入</h4><ul><li><UiIcon name="check" :size="13" />Agent Profile</li><li><UiIcon name="check" :size="13" />任务上下文</li></ul></section>
              <section><h4>配置</h4><dl><div><dt>引用类型</dt><dd>{{ (detailResource.sourceKind || detailResource.kind).toUpperCase() }}</dd></div><div><dt>引用键</dt><dd>{{ detailResource.key }}</dd></div><div><dt>状态</dt><dd>已启用</dd></div></dl></section>
              <button type="button" class="detail-remove" @click="removeCanvasResource(detailResource)">移除该能力</button>
            </template>
            <div v-else class="detail-empty"><UiIcon name="workflow" :size="24" /><span>选择画布节点查看详情</span></div>
          </aside>
        </div>

        <div v-else class="secondary-view">
          <section v-if="activeTab === 'config'" class="config-view"><div><span>Agent 状态</span><strong>{{ selectedAgent ? statusLabel(selectedAgent.status) : '草稿' }}</strong></div><div><span>能力数量</span><strong>{{ canvasResources.length }}</strong></div><div><span>Profile Token</span><strong>{{ compiled?.estimatedTokens ?? '—' }}</strong></div><div><span>标签</span><strong>{{ activeForm?.tags || '未配置' }}</strong></div><button v-if="selectedAgent" type="button" @click="toggleAgentStatus(selectedAgent)">{{ selectedAgent.status === 'active' ? '停用 Agent' : '启用 Agent' }}</button></section>
          <section v-else-if="activeTab === 'test'" class="test-view"><span :class="{ error: hasBlockingErrors }"><UiIcon :name="hasBlockingErrors ? 'x' : 'check'" :size="24" /></span><div><h3>{{ hasBlockingErrors ? 'Profile 校验未通过' : 'Profile 校验通过' }}</h3><p>{{ validating ? '正在校验当前配置…' : diagnostics.length ? `${diagnostics.length} 条诊断信息` : '引用和能力授权关系有效。' }}</p></div><button type="button" @click="revalidate">重新测试</button></section>
          <section v-else-if="activeTab === 'logs'" class="timeline-view"><div><time>{{ selectedAgent ? formatUpdatedAt(selectedAgent.updatedAt) : '当前' }}</time><strong>Profile 配置已更新</strong><p>当前版本包含 {{ canvasResources.length }} 项能力。</p></div><div><time>{{ selectedAgent ? formatUpdatedAt(selectedAgent.createdAt) : '当前' }}</time><strong>Agent 已创建</strong><p>建立 Agent 身份与能力边界。</p></div></section>
          <section v-else class="version-view"><header><span>版本</span><span>状态</span><span>更新时间</span></header><div><strong>v{{ selectedAgent?.profileRevision ?? 1 }}</strong><em>当前版本</em><time>{{ selectedAgent ? formatUpdatedAt(selectedAgent.updatedAt) : '尚未保存' }}</time></div></section>
        </div>

        <div v-if="profilePanelOpen && activeForm" class="profile-backdrop" @click.self="profilePanelOpen = false">
          <section class="profile-editor" role="dialog" aria-modal="true" aria-label="Agent 资料编辑">
            <header><div><h2>{{ showCreateForm ? '新建 Agent' : '编辑 Agent 资料' }}</h2><p>维护身份信息与 Profile Markdown</p></div><button type="button" title="关闭" @click="profilePanelOpen = false"><UiIcon name="x" :size="17" /></button></header>
            <div class="profile-fields"><label><span>名称</span><input v-model.trim="activeForm.name" type="text" placeholder="例如 前端开发 Agent" /></label><label><span>标签</span><input v-model.trim="activeForm.tags" type="text" placeholder="例如 frontend, vue" /></label></div>
            <div class="profile-tabs"><button type="button" :class="{ active: previewMode === 'source' }" @click="previewMode = 'source'">源码</button><button type="button" :class="{ active: previewMode === 'preview' }" @click="previewMode = 'preview'">编译预览</button><span>{{ validating ? '校验中…' : compiled ? `约 ${compiled.estimatedTokens} tokens` : '' }}</span></div>
            <textarea v-if="previewMode === 'source'" ref="editorRef" v-model="activeForm.profileMarkdown" rows="18" @drop="onDropReference" @dragover.prevent></textarea><pre v-else>{{ compiled?.systemPrompt || '暂无编译结果' }}</pre>
            <div v-if="diagnostics.length" class="profile-diagnostics"><p v-for="(diagnostic, index) in diagnostics" :key="index" :class="diagnostic.severity"><UiIcon :name="diagnostic.severity === 'error' ? 'x' : 'check'" :size="14" />{{ diagnostic.message }}</p></div>
            <div class="profile-capabilities"><span v-for="capabilityId in activeForm.capabilityIds" :key="capabilityId">{{ capabilityLabel(capabilityId) }}</span><small v-if="!activeForm.capabilityIds.length">未授予 Tool 能力</small></div>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <footer><button type="button" @click="showCreateForm ? cancelCreate() : cancelEdit()">取消</button><button type="button" class="primary" :disabled="hasBlockingErrors || Boolean(savingAgentId)" @click="showCreateForm ? createAgent() : selectedAgent ? updateAgent(selectedAgent) : undefined">{{ savingAgentId ? '保存中' : showCreateForm ? '创建 Agent' : '保存 Agent' }}</button></footer>
          </section>
        </div>
      </main>

      <section v-else class="agent-designer empty-designer"><span><UiIcon name="users" :size="28" /></span><h2>暂无 Agent</h2><button type="button" class="agent-primary" @click="beginCreate"><UiIcon name="plus" :size="16" />新建 Agent</button></section>
    </div>

  </div>
</template>

<style scoped>
/* High-density Agent capability workbench */
.agent-manager { --am-blue:#2468f2; --am-text:#10213f; --am-muted:#687b9c; --am-border:#dce5f2; display:grid; grid-template-rows:auto minmax(0,1fr); gap:0; height:100%; min-height:700px; color:var(--am-text); background:#f6f9fe; }
.agent-manager button,.agent-manager input,.agent-manager textarea { font:inherit; }
.agent-page-head { display:flex; align-items:center; justify-content:space-between; gap:24px; min-height:74px; padding:12px 20px; border-bottom:1px solid #e5ebf5; background:#f8fbff; }
.agent-page-title,.agent-page-summary,.agent-page-summary dl,.agent-current,.designer-actions,.resource-group h3,.resource-search,.detail-identity { display:flex; align-items:center; }
.agent-page-logo { display:grid; place-items:center; width:40px; height:40px; margin-right:12px; border-radius:8px; background:var(--am-blue); color:#fff; box-shadow:0 8px 18px rgb(36 104 242 / 22%); }
.agent-manager h1,.agent-manager h2,.agent-manager h3,.agent-manager h4,.agent-manager p { margin:0; }
.agent-page-title h1 { font-size:20px; line-height:1.25; letter-spacing:0; }.agent-page-title p { margin-top:4px; color:var(--am-muted); font-size:12px; }
.agent-page-summary { gap:16px; }.agent-page-summary dl { gap:24px; margin:0; }.agent-page-summary dl div { display:grid; justify-items:center; gap:2px; }.agent-page-summary dt { color:#7184a5; font-size:11px; }.agent-page-summary dd { margin:0; font-size:14px; font-weight:800; }.agent-page-summary > i { width:1px; height:30px; background:#e2e8f2; }
.agent-primary { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:36px; padding:0 14px; border:1px solid var(--am-blue); border-radius:6px; background:var(--am-blue); color:#fff; font-size:13px; font-weight:700; box-shadow:0 5px 12px rgb(36 104 242 / 18%); transition:background 180ms ease,box-shadow 180ms ease; }.agent-primary:hover { background:#1859dc; box-shadow:0 7px 16px rgb(36 104 242 / 25%); }
.agent-page-body { display:grid; grid-template-columns:244px minmax(0,1fr); gap:14px; min-height:0; padding:0 20px 18px; }
.agent-directory,.agent-designer { min-width:0; min-height:0; border:1px solid var(--am-border); border-radius:7px; background:#fff; box-shadow:0 5px 16px rgb(34 72 130 / 5%); }
.agent-directory { display:grid; grid-template-rows:auto auto minmax(0,1fr) auto; gap:12px; padding:18px 14px 14px; }.agent-directory h2 { font-size:14px; }
.agent-search,.resource-search label { display:flex; align-items:center; gap:7px; min-height:32px; padding:0 10px; border:1px solid #d8e1ef; border-radius:6px; color:#8ca0be; background:#fff; }.agent-search:focus-within,.resource-search label:focus-within { border-color:#79a5ff; box-shadow:0 0 0 3px rgb(36 104 242 / 9%); }.agent-search input,.resource-search input { width:100%; min-width:0; border:0; outline:0; color:var(--am-text); background:transparent; font-size:12px; }.agent-search input::placeholder,.resource-search input::placeholder { color:#a0aec3; }
.agent-directory-list { display:grid; align-content:start; gap:7px; min-height:0; overflow-y:auto; scrollbar-width:thin; }.agent-directory-list > p { padding:24px 8px; color:var(--am-muted); font-size:12px; text-align:center; }
.agent-row { display:grid; grid-template-columns:30px minmax(0,1fr) auto; align-items:center; gap:9px; width:100%; min-height:64px; padding:9px; border:1px solid #e4eaf3; border-radius:6px; background:#fff; color:var(--am-text); text-align:left; transition:border-color 180ms ease,background 180ms ease,box-shadow 180ms ease; }.agent-row:hover { border-color:#aac7fb; background:#fbfdff; }.agent-row.selected { border-color:#5f91ff; background:#f5f9ff; box-shadow:0 4px 11px rgb(36 104 242 / 8%); }
.agent-row-icon,.resource-main > span:first-child,.flow-node-icon,.detail-identity > span,.agent-current > span { display:grid; place-items:center; flex:0 0 auto; width:30px; height:30px; border-radius:7px; background:#eaf2ff; color:var(--am-blue); }.agent-row > span:nth-child(2) { display:grid; gap:5px; min-width:0; }.agent-row strong,.agent-row small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.agent-row strong { font-size:12px; }.agent-row small { color:#7184a5; font-size:9px; }.agent-row em { color:#16a46a; font-size:10px; font-style:normal; font-weight:700; }.agent-row em.disabled { color:#94a3b8; }
.agent-directory-create { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:32px; border:1px solid #dbe4f1; border-radius:6px; background:#fff; color:#18355f; font-size:11px; font-weight:700; }.agent-directory-create:hover { border-color:#8eb2f7; color:var(--am-blue); }
.agent-designer { position:relative; display:grid; grid-template-rows:auto auto minmax(0,1fr); overflow:hidden; }.agent-designer-top { display:grid; grid-template-rows:48px 40px; padding:0 14px; border-bottom:1px solid var(--am-border); }.agent-current { gap:9px; }.agent-current strong { font-size:15px; }.agent-current > span { width:28px; height:28px; }.agent-current button,.resource-group header button,.resource-search > button,.resource-items > li > button:last-child,.capability-detail > header button,.profile-editor > header button { display:grid; place-items:center; width:29px; height:29px; padding:0; border:1px solid #dbe4f1; border-radius:6px; background:#fff; color:#607493; }.agent-current button { width:24px; height:24px; border:0; background:transparent; }.agent-current button:hover,.resource-group header button:hover,.resource-search > button:hover { border-color:#8eb2f7; color:var(--am-blue); }
.agent-designer-top nav { display:flex; align-items:end; gap:28px; }.agent-designer-top nav button { position:relative; height:40px; padding:0 2px; border:0; background:transparent; color:#657897; font-size:12px; }.agent-designer-top nav button.active { color:var(--am-blue); font-weight:700; }.agent-designer-top nav button.active::after { content:''; position:absolute; right:0; bottom:-1px; left:0; height:2px; background:var(--am-blue); }
.designer-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:64px; padding:10px 14px; }.designer-heading h2 { font-size:13px; }.designer-heading p { margin-top:4px; color:#7184a5; font-size:10px; }.designer-actions { gap:8px; }.designer-actions > button { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:29px; padding:0 10px; border:1px solid #dce5f2; border-radius:5px; background:#fff; color:#486181; font-size:10px; font-weight:600; }.designer-actions > button:hover { border-color:#8eb2f7; color:var(--am-blue); }.designer-actions > i { width:1px; height:22px; margin:0 3px; background:#e1e7f0; }.designer-actions > button.save { border-color:var(--am-blue); background:var(--am-blue); color:#fff; }
.designer-grid { display:grid; grid-template-columns:282px minmax(360px,1fr) 278px; gap:12px; min-height:0; padding:0 14px 14px; }.resource-library,.capability-canvas,.capability-detail { min-width:0; min-height:0; border:1px solid var(--am-border); border-radius:6px; background:#fff; }.resource-library { display:grid; grid-template-rows:minmax(0,1fr) minmax(0,1fr); gap:12px; border:0; }.resource-group { display:grid; grid-template-rows:auto auto minmax(0,1fr); min-height:0; padding:10px; border:1px solid var(--am-border); border-radius:6px; }.resource-group > header { display:flex; align-items:center; justify-content:space-between; min-height:30px; }.resource-group h3 { gap:6px; color:#18355f; font-size:12px; }
.resource-search { gap:5px; margin:4px 0 8px; }.resource-search label { flex:1; min-width:0; min-height:30px; }.resource-items { display:grid; align-content:start; gap:4px; min-height:0; margin:0; padding:0; overflow-y:auto; list-style:none; scrollbar-width:thin; }.resource-items li { display:grid; grid-template-columns:minmax(0,1fr) auto 28px; align-items:center; gap:5px; min-height:43px; padding:4px 2px 4px 5px; border:1px solid transparent; border-radius:5px; background:#fbfcfe; }.resource-items li:hover { border-color:#d7e4f7; background:#f6f9fe; }.resource-main { display:flex; align-items:center; gap:8px; min-width:0; padding:0; border:0; background:transparent; color:var(--am-text); text-align:left; }.resource-main > span:first-child { width:25px; height:25px; border-radius:5px; }.resource-main > span:last-child { display:grid; gap:2px; min-width:0; }.resource-main strong,.resource-main small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.resource-main strong { font-size:10px; }.resource-main small { color:#7184a5; font-size:8px; }.resource-items em { color:#5590ee; font-size:8px; font-style:normal; }.resource-items li.empty { display:grid; place-items:center; color:#94a3b8; font-size:10px; }
.tone-1 { background:#eee7ff !important; color:#7c3aed !important; }.tone-2 { background:#e8f1ff !important; color:#2f6fe8 !important; }.tone-3 { background:#e1f8f5 !important; color:#0ba69b !important; }.tone-4 { background:#fff3dc !important; color:#e7960b !important; }.tone-5 { background:#ffe9ef !important; color:#e64d79 !important; }
.capability-canvas { position:relative; overflow:auto; background-color:#fbfdff; background-image:linear-gradient(rgb(95 124 168 / 7%) 1px,transparent 1px),linear-gradient(90deg,rgb(95 124 168 / 7%) 1px,transparent 1px),radial-gradient(circle,rgb(91 118 158 / 15%) 1px,transparent 1.2px); background-size:24px 24px,24px 24px,12px 12px; }.canvas-flow { display:flex; flex-direction:column; align-items:center; min-width:350px; min-height:100%; padding:22px 30px 60px; }.flow-terminal { display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 14px; border:1px solid #77d89a; border-radius:16px; background:#ebfbf0; color:#258b4d; font-size:11px; }.flow-terminal span { width:9px; height:9px; border:2px solid currentColor; border-radius:50%; }.flow-terminal.end { border-color:#aebbd0; background:#f0f4f9; color:#607493; }
.flow-add { position:relative; display:grid; place-items:center; width:19px; height:19px; margin:11px 0; padding:0; border:1px solid #cfdae9; border-radius:50%; background:#fff; color:#607493; z-index:1; }.flow-add::before,.flow-add::after { content:''; position:absolute; left:50%; width:1px; height:12px; background:#b7c5d8; transform:translateX(-50%); z-index:-1; }.flow-add::before { bottom:100%; }.flow-add::after { top:100%; }
.flow-node { display:grid; grid-template-columns:29px minmax(0,1fr) auto 22px; align-items:center; gap:8px; width:min(250px,80%); min-height:58px; padding:8px 9px; border:1px solid currentColor; border-radius:8px; background:#fff !important; color:#9e75eb; box-shadow:0 5px 14px rgb(31 64 115 / 9%); cursor:pointer; transition:box-shadow 180ms ease,transform 180ms ease; }.flow-node:hover,.flow-node.selected { box-shadow:0 8px 19px rgb(36 104 242 / 17%); transform:translateY(-1px); }.flow-node-icon { width:27px; height:27px; color:inherit; }.flow-node-copy { display:grid; gap:3px; min-width:0; color:var(--am-text); }.flow-node-copy strong,.flow-node-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.flow-node-copy strong { font-size:10px; }.flow-node-copy small { color:#7184a5; font-size:8px; }.flow-node em { color:inherit; font-size:8px; font-style:normal; }.flow-node > button { display:grid; place-items:center; width:22px; height:22px; padding:0; border:0; border-radius:4px; background:transparent; color:#7890ae; }.layout-branch .flow-node:nth-of-type(4n) { transform:translateX(-70px); }.layout-branch .flow-node:nth-of-type(4n + 2) { transform:translateX(70px); }
.canvas-empty { display:grid; justify-items:center; gap:6px; margin:4px 0 14px; color:#8294ad; font-size:11px; }.canvas-empty > span { display:grid; place-items:center; width:42px; height:42px; border-radius:50%; background:#eef4fd; color:var(--am-blue); }.canvas-empty small { font-size:9px; }.canvas-toolbar { position:sticky; right:10px; bottom:8px; display:flex; align-items:center; justify-content:flex-end; gap:2px; width:max-content; margin:auto 8px 0 auto; padding:3px; border:1px solid #dce5f2; border-radius:6px; background:rgb(255 255 255 / 94%); box-shadow:0 3px 10px rgb(31 64 115 / 8%); }.canvas-toolbar button { display:grid; place-items:center; width:26px; height:24px; padding:0; border:0; background:transparent; color:#607493; }.canvas-toolbar strong { min-width:42px; color:#40597b; font-size:10px; text-align:center; }
.capability-detail { display:flex; flex-direction:column; padding:12px; overflow-y:auto; }.capability-detail > header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }.capability-detail h3 { font-size:12px; }.detail-identity { gap:9px; padding-bottom:12px; }.detail-identity > span { display:grid; place-items:center; width:32px; height:32px; border-radius:7px; }.detail-identity > div { display:grid; grid-template-columns:auto auto; align-items:center; gap:2px 7px; min-width:0; }.detail-identity strong { font-size:11px; }.detail-identity em { color:#5590ee; font-size:8px; font-style:normal; }.detail-identity small { grid-column:1 / -1; color:#7184a5; font-size:8px; }
.capability-detail section { padding:10px 8px; border-top:1px solid #eef2f7; background:#fbfcfe; }.capability-detail h4 { margin-bottom:7px; font-size:9px; }.capability-detail section p { color:#617493; font-size:9px; line-height:1.6; }.capability-detail ul { display:grid; gap:6px; margin:0; padding:0; list-style:none; }.capability-detail li { display:flex; align-items:center; gap:6px; color:#607493; font-size:9px; }.capability-detail dl { display:grid; gap:6px; margin:0; }.capability-detail dl div { display:grid; grid-template-columns:70px minmax(0,1fr); gap:8px; font-size:9px; }.capability-detail dt { color:#7b8ca6; }.capability-detail dd { margin:0; color:#213a60; overflow-wrap:anywhere; }.detail-remove { min-height:31px; margin-top:auto; border:1px solid #ffb9c5; border-radius:5px; background:#fff; color:#e34864; font-size:10px; }.detail-empty { display:grid; place-items:center; gap:8px; margin:auto; color:#8a9bb4; font-size:10px; }
.secondary-view { min-height:0; padding:0 14px 14px; }.config-view,.test-view,.timeline-view,.version-view { min-height:420px; padding:24px; border:1px solid var(--am-border); border-radius:6px; background:#fbfdff; }.config-view { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); align-content:start; gap:12px; }.config-view div { display:grid; gap:7px; padding:14px; border:1px solid #e2e9f3; border-radius:6px; background:#fff; }.config-view span { color:#7184a5; font-size:10px; }.config-view strong { font-size:13px; overflow-wrap:anywhere; }.config-view > button { grid-column:1 / -1; justify-self:start; min-height:34px; padding:0 12px; border:1px solid #dce5f2; border-radius:5px; background:#fff; color:#526987; }
.test-view { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-content:start; align-items:center; gap:14px; }.test-view > span { display:grid; place-items:center; width:48px; height:48px; border-radius:50%; background:#e9f9f0; color:#20a366; }.test-view > span.error { background:#fff0f2; color:#e34864; }.test-view h3 { font-size:14px; }.test-view p { margin-top:5px; color:#7184a5; font-size:11px; }.test-view > button { min-height:32px; padding:0 12px; border:1px solid #b9cef4; border-radius:5px; background:#fff; color:var(--am-blue); }
.timeline-view { display:grid; align-content:start; gap:0; }.timeline-view > div { display:grid; grid-template-columns:130px minmax(0,1fr); gap:4px 20px; padding:0 0 28px 24px; border-left:1px solid #ccd8e8; }.timeline-view time { grid-row:1 / 3; color:#7184a5; font-size:10px; }.timeline-view strong { font-size:12px; }.timeline-view p { color:#7184a5; font-size:10px; }.version-view { padding:0; overflow:hidden; }.version-view header,.version-view > div { display:grid; grid-template-columns:1fr 1fr 2fr; gap:12px; padding:13px 16px; }.version-view header { border-bottom:1px solid #dce5f2; background:#f4f7fb; color:#7184a5; font-size:10px; }.version-view > div { align-items:center; background:#fff; font-size:11px; }.version-view em { justify-self:start; padding:3px 7px; border-radius:10px; background:#e7f8ee; color:#208b54; font-style:normal; }.version-view time { color:#7184a5; }
.profile-backdrop { position:absolute; inset:0; display:grid; place-items:center; padding:20px; background:rgb(16 33 63 / 32%); z-index:10; }.profile-editor { display:grid; grid-template-rows:auto auto auto minmax(240px,1fr) auto auto auto; gap:12px; width:min(760px,100%); max-height:calc(100% - 20px); padding:18px; overflow:auto; border:1px solid #d7e1ef; border-radius:8px; background:#fff; box-shadow:0 20px 50px rgb(20 45 82 / 24%); }.profile-editor > header { display:flex; align-items:flex-start; justify-content:space-between; }.profile-editor h2 { font-size:16px; }.profile-editor header p { margin-top:4px; color:#7184a5; font-size:10px; }.profile-fields { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.profile-fields label { display:grid; gap:6px; }.profile-fields label span { color:#607493; font-size:10px; font-weight:700; }.profile-fields input { min-height:34px; padding:0 10px; border:1px solid #d7e1ef; border-radius:5px; outline:0; }
.profile-tabs { display:flex; align-items:center; gap:6px; }.profile-tabs button { min-height:28px; padding:0 10px; border:1px solid #dbe4f1; border-radius:5px; background:#fff; color:#607493; font-size:10px; }.profile-tabs button.active { border-color:var(--am-blue); background:var(--am-blue); color:#fff; }.profile-tabs span { margin-left:auto; color:#7184a5; font-size:10px; }.profile-editor textarea,.profile-editor pre { box-sizing:border-box; width:100%; min-height:260px; margin:0; padding:12px; overflow:auto; border:1px solid #d7e1ef; border-radius:6px; outline:0; background:#fbfcfe; color:#1d3557; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; line-height:1.6; white-space:pre-wrap; resize:vertical; }.profile-diagnostics { display:grid; gap:5px; }.profile-diagnostics p { display:flex; align-items:center; gap:5px; color:#ad7017; font-size:10px; }.profile-diagnostics p.error,.form-error { color:#d5415c; }.profile-capabilities { display:flex; flex-wrap:wrap; gap:5px; }.profile-capabilities span { padding:4px 7px; border-radius:4px; background:#eef4fd; color:#315d9c; font-size:9px; }.profile-capabilities small { color:#8a9bb4; }.profile-editor footer { display:flex; justify-content:flex-end; gap:8px; }.profile-editor footer button { min-height:33px; padding:0 13px; border:1px solid #d8e2ef; border-radius:5px; background:#fff; color:#526987; }.profile-editor footer button.primary { border-color:var(--am-blue); background:var(--am-blue); color:#fff; }.form-error { font-size:10px; }
.empty-designer { display:grid; place-items:center; align-content:center; gap:10px; }.empty-designer > span { display:grid; place-items:center; width:58px; height:58px; border-radius:50%; background:#edf4ff; color:var(--am-blue); }.empty-designer h2 { font-size:15px; }
@media (max-width:1450px) { .designer-grid { grid-template-columns:250px minmax(340px,1fr) 240px; }.designer-actions > button { padding:0 7px; }.resource-items li { grid-template-columns:minmax(0,1fr) 28px; }.resource-items li > em { display:none; } }
@media (max-width:1180px) { .agent-page-body { grid-template-columns:210px minmax(0,1fr); }.designer-grid { grid-template-columns:235px minmax(340px,1fr); }.capability-detail { display:none; }.designer-actions > button:not(.save) { width:30px; padding:0; overflow:hidden; font-size:0; } }
@media (max-width:900px) { .agent-manager { height:auto; min-height:100vh; overflow:auto; }.agent-page-title p { display:none; }.agent-page-body { grid-template-columns:1fr; min-height:auto; }.agent-directory { grid-template-rows:auto auto minmax(0,1fr) auto; min-height:230px; }.agent-directory-list { display:flex; overflow-x:auto; }.agent-row { flex:0 0 220px; }.agent-designer { min-height:760px; }.designer-grid { grid-template-columns:230px minmax(340px,1fr); overflow-x:auto; } }
@media (max-width:620px) { .agent-page-head { align-items:flex-start; flex-direction:column; }.agent-page-summary { width:100%; justify-content:space-between; }.agent-page-body { padding:0 10px 12px; }.agent-designer { min-height:1020px; overflow:visible; }.designer-heading { align-items:flex-start; flex-direction:column; }.designer-actions { width:100%; overflow-x:auto; }.designer-grid { grid-template-columns:1fr; min-height:850px; overflow:visible; }.resource-library { grid-template-columns:1fr 1fr; grid-template-rows:300px; overflow-x:auto; }.resource-group { min-width:250px; }.capability-canvas { min-height:520px; }.profile-fields,.config-view { grid-template-columns:1fr; }.profile-backdrop { position:fixed; padding:10px; }.profile-editor { max-height:calc(100vh - 20px); } }
@media (prefers-reduced-motion:reduce) { .agent-row,.flow-node,.agent-primary { transition:none; } }
</style>
