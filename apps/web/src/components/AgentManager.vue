<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useSkillStore } from '@/stores/skill'
import type { Agent, CapabilityDefinition, CompiledAgentProfile, ProfileDiagnostic } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

type AgentFormState = {
  name: string
  tags: string
  profileMarkdown: string
  capabilityIds: string[]
}

const props = defineProps<{
  agents: Agent[]
  capabilities: CapabilityDefinition[]
}>()

const agentStore = useAgentStore()
const skillStore = useSkillStore()

const showCreateForm = ref(false)
const editingAgentId = ref('')
const savingAgentId = ref('')
const formError = ref('')
const resourceTab = ref<'skill' | 'tool'>('skill')
const resourceSearch = ref('')
const expandedResourceId = ref<string | null>(null)
const previewMode = ref<'source' | 'preview'>('source')
const diagnostics = ref<ProfileDiagnostic[]>([])
const compiled = ref<CompiledAgentProfile | null>(null)
const validating = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)

const createForm = ref<AgentFormState>(emptyForm())
const editForms = ref<Record<string, AgentFormState>>({})

const activeAgentCount = computed(() => props.agents.filter((agent) => agent.status === 'active').length)
const capabilityNameById = computed(() => new Map(props.capabilities.map((capability) => [capability.id, capability.name])))
const activeForm = computed<AgentFormState | null>(() => {
  if (showCreateForm.value) return createForm.value
  if (editingAgentId.value) return editForms.value[editingAgentId.value] ?? null
  return null
})

// 只有可插入的 Tool（非 internal）才允许 ${tool:key} 引用。
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

function emptyForm(): AgentFormState {
  return {
    name: '',
    tags: '',
    profileMarkdown: '# 新 Agent\n\n## 工作职责\n\n描述该 Agent 的职责。\n\n## 专项技能\n\n## 可用工具\n',
    capabilityIds: []
  }
}

function formFromAgent(agent: Agent): AgentFormState {
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

function statusLabel(status: Agent['status']) {
  return status === 'active' ? '启用中' : '已停用'
}

function capabilityLabel(capabilityId: string) {
  return capabilityNameById.value.get(capabilityId) ?? capabilityId
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

function toggleResourceDetail(id: string) {
  expandedResourceId.value = expandedResourceId.value === id ? null : id
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
}

function startEdit(agent: Agent) {
  editForms.value = { ...editForms.value, [agent.id]: formFromAgent(agent) }
  formError.value = ''
  diagnostics.value = []
  compiled.value = null
  editingAgentId.value = agent.id
  showCreateForm.value = false
  void revalidate()
}

function cancelEdit() {
  editingAgentId.value = ''
  formError.value = ''
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

async function updateAgent(agent: Agent) {
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
    cancelEdit()
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

async function toggleAgentStatus(agent: Agent) {
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
</script>

<template>
  <div class="agent-manager">
    <article class="admin-card agent-manager-toolbar">
      <div>
        <strong>Agent 能力维护</strong>
        <p>用 Markdown 描述 Agent 职责，并通过 Skill/Tool 引用组合能力。Agent 与模型/运行时已解绑。</p>
      </div>
      <dl>
        <div><dt>总数</dt><dd>{{ agents.length }}</dd></div>
        <div><dt>启用</dt><dd>{{ activeAgentCount }}</dd></div>
      </dl>
      <button type="button" class="primary" @click="startCreate">
        <UiIcon name="plus" :size="16" />
        新建 Agent
      </button>
    </article>

    <section v-if="showCreateForm || editingAgentId" class="admin-card agent-editor-layout">
      <div class="agent-editor-basic">
        <label>
          <span>名称</span>
          <input v-if="activeForm" v-model="activeForm.name" type="text" placeholder="例如 前端开发 Agent" />
        </label>
        <label>
          <span>标签</span>
          <input v-if="activeForm" v-model="activeForm.tags" type="text" placeholder="例如 frontend, vue" />
        </label>
        <div class="agent-editor-caps">
          <span>已授予能力（Tool 引用需在此授权）</span>
          <div class="tag-row">
            <span v-for="capId in activeForm?.capabilityIds ?? []" :key="capId" class="tag">
              {{ capabilityLabel(capId) }}
            </span>
            <span v-if="!activeForm?.capabilityIds.length" class="tag muted">未授予能力</span>
          </div>
        </div>
      </div>

      <div class="agent-editor-main">
        <div class="agent-editor-tabs">
          <button type="button" :class="{ active: previewMode === 'source' }" @click="previewMode = 'source'">源码</button>
          <button type="button" :class="{ active: previewMode === 'preview' }" @click="previewMode = 'preview'">预览</button>
          <span v-if="validating" class="agent-editor-validating">校验中…</span>
          <span v-else-if="compiled" class="agent-editor-validating">约 {{ compiled.estimatedTokens }} tokens</span>
        </div>
        <textarea
          v-if="activeForm && previewMode === 'source'"
          ref="editorRef"
          v-model="activeForm.profileMarkdown"
          class="agent-editor-textarea"
          rows="18"
          @drop="onDropReference"
          @dragover.prevent
        />
        <pre v-else-if="compiled" class="agent-editor-preview">{{ compiled.systemPrompt }}</pre>
        <pre v-else class="agent-editor-preview">保存或校验后可预览编译结果。</pre>

        <div v-if="diagnostics.length" class="agent-editor-diagnostics">
          <p v-for="(d, i) in diagnostics" :key="i" :class="['diagnostic', d.severity]">
            <UiIcon :name="d.severity === 'error' ? 'x' : 'check'" :size="14" />
            <span>{{ d.line ? `行 ${d.line}: ` : '' }}{{ d.message }}</span>
          </p>
        </div>
      </div>

      <aside class="agent-editor-resources">
        <div class="agent-editor-tabs">
          <button type="button" :class="{ active: resourceTab === 'skill' }" @click="resourceTab = 'skill'">Skill</button>
          <button type="button" :class="{ active: resourceTab === 'tool' }" @click="resourceTab = 'tool'">Tool</button>
        </div>
        <input v-model="resourceSearch" type="search" placeholder="搜索资源…" class="agent-editor-search" />
        <ul v-if="resourceTab === 'skill'" class="agent-editor-resource-list">
          <li
            v-for="skill in filteredSkills"
            :key="skill.id"
            draggable="true"
            @dragstart="onDragStart($event, 'skill', skill.key ?? '')"
            :class="{ expanded: expandedResourceId === skill.id }"
          >
            <div class="resource-header">
              <div class="resource-info">
                <strong>{{ skill.name }}</strong>
                <code>${skill:{{ skill.key }}}</code>
                <small v-if="skill.description">{{ skill.description }}</small>
              </div>
              <div class="resource-actions">
                <button type="button" @click.stop="toggleResourceDetail(skill.id)">
                  {{ expandedResourceId === skill.id ? '收起' : '详情' }}
                </button>
                <button type="button" @click="insertReference('skill', skill.key ?? '')">插入</button>
              </div>
            </div>
            <div v-if="expandedResourceId === skill.id" class="resource-detail">
              <dl v-if="skill.content">
                <dt>内容</dt>
                <dd><pre>{{ skill.content }}</pre></dd>
              </dl>
              <dl v-if="skill.files?.length">
                <dt>附件文件 ({{ skill.files.length }})</dt>
                <dd>
                  <ul>
                    <li v-for="file in skill.files" :key="file.path">
                      <code>{{ file.path }}</code>
                    </li>
                  </ul>
                </dd>
              </dl>
            </div>
          </li>
          <li v-if="!filteredSkills.length" class="empty">暂无 Skill</li>
        </ul>
        <ul v-else class="agent-editor-resource-list">
          <li
            v-for="tool in filteredTools"
            :key="tool.id"
            draggable="true"
            @dragstart="onDragStart($event, 'tool', tool.key, tool.id)"
            :class="{ expanded: expandedResourceId === tool.id }"
          >
            <div class="resource-header">
              <div class="resource-info">
                <strong>{{ tool.name }}</strong>
                <code>${tool:{{ tool.key }}}</code>
                <small>风险: {{ tool.riskLevel }}</small>
              </div>
              <div class="resource-actions">
                <button type="button" @click.stop="toggleResourceDetail(tool.id)">
                  {{ expandedResourceId === tool.id ? '收起' : '详情' }}
                </button>
                <button type="button" @click="insertReference('tool', tool.key, tool.id)">插入</button>
              </div>
            </div>
            <div v-if="expandedResourceId === tool.id" class="resource-detail">
              <dl v-if="tool.descriptionMarkdown">
                <dt>描述</dt>
                <dd><pre>{{ tool.descriptionMarkdown }}</pre></dd>
              </dl>
              <dl v-if="tool.usageMarkdown">
                <dt>使用说明</dt>
                <dd><pre>{{ tool.usageMarkdown }}</pre></dd>
              </dl>
              <dl>
                <dt>状态</dt>
                <dd>{{ tool.status }}</dd>
              </dl>
              <dl v-if="tool.systemOwned">
                <dt>系统能力</dt>
                <dd>是</dd>
              </dl>
            </div>
          </li>
          <li v-if="!filteredTools.length" class="empty">暂无可插入 Tool</li>
        </ul>
      </aside>

      <footer class="agent-editor-footer">
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <div class="form-actions">
          <button type="button" @click="showCreateForm ? cancelCreate() : cancelEdit()">取消</button>
          <button
            v-if="showCreateForm"
            type="button"
            class="primary"
            :disabled="savingAgentId === 'new' || hasBlockingErrors"
            @click="createAgent"
          >
            {{ savingAgentId === 'new' ? '创建中' : '创建 Agent' }}
          </button>
          <button
            v-else
            type="button"
            class="primary"
            :disabled="savingAgentId === editingAgentId || hasBlockingErrors"
            @click="updateAgent(agents.find((a) => a.id === editingAgentId)!)"
          >
            {{ savingAgentId === editingAgentId ? '保存中' : '保存 Agent' }}
          </button>
        </div>
      </footer>
    </section>

    <section class="agent-maintenance-list">
      <article v-for="agent in agents" :key="agent.id" class="admin-card agent-maintenance-card">
        <header>
          <div>
            <strong>{{ agent.name }}</strong>
            <p>{{ agent.role }}</p>
          </div>
          <span :class="['agent-maintenance-status', agent.status]">{{ statusLabel(agent.status) }}</span>
        </header>
        <dl>
          <div><dt>Key</dt><dd>{{ agent.key }}</dd></div>
          <div><dt>技能引用</dt><dd>{{ agent.skillIds?.length ?? 0 }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ agent.updatedAt }}</dd></div>
        </dl>
        <div class="tag-row">
          <span v-for="tag in agent.tags" :key="tag" class="tag">{{ tag }}</span>
          <span v-if="!agent.tags?.length" class="tag muted">无标签</span>
        </div>
        <div class="tag-row">
          <span v-for="capabilityId in agent.capabilityIds" :key="capabilityId" class="tag">
            {{ capabilityLabel(capabilityId) }}
          </span>
          <span v-if="!agent.capabilityIds.length" class="tag muted">未配置能力</span>
        </div>
        <footer class="agent-maintenance-actions">
          <button type="button" @click="startEdit(agent)">
            <UiIcon name="settings" :size="16" />
            编辑
          </button>
          <button type="button" :disabled="savingAgentId === agent.id" @click="toggleAgentStatus(agent)">
            <UiIcon :name="agent.status === 'active' ? 'x' : 'check'" :size="16" />
            {{ agent.status === 'active' ? '停用' : '启用' }}
          </button>
        </footer>
      </article>
      <p v-if="!agents.length" class="admin-empty">暂无 Agent，请先新建 Agent。</p>
    </section>
  </div>
</template>

<style scoped>
.agent-editor-resource-list li {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.agent-editor-resource-list li.expanded {
  border-left: 2px solid var(--color-primary, #3b82f6);
}

.resource-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
  width: 100%;
}

.resource-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.resource-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.resource-detail {
  padding: 0.75rem;
  background: var(--color-bg-subtle, #f5f5f5);
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.resource-detail dl {
  margin: 0.5rem 0;
}

.resource-detail dt {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.resource-detail dd {
  margin: 0;
  color: var(--color-text-secondary, #666);
}

.resource-detail pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: monospace;
  font-size: 0.875rem;
  margin: 0;
}

.resource-detail ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.resource-detail ul li {
  padding: 0.25rem 0;
  border: none;
}
</style>
