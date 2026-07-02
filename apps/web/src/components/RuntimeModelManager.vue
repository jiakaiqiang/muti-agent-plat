<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import type { Agent, RuntimeModelKind, RuntimeModelOption, RuntimeModelUpdateInput } from '@/types/contracts'
import { runtimeTypeLabel } from '@/utils/runtimeLabels'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  agents: Agent[]
  capabilityName: (capabilityId: string) => string
}>()

const agentStore = useAgentStore()
const modelStore = useRuntimeModelStore()
const selectedModelId = ref('')
const selectedAgentId = ref('')
const markdownDraft = ref('')
const markdownMode = ref<'edit' | 'preview'>('edit')
const markdownDialogOpen = ref(false)
const markdownSaving = ref(false)
const markdownError = ref('')
const addMode = ref<RuntimeModelKind>('local')
const localModelName = ref('')
const remoteLabel = ref('')
const remoteModelName = ref('')
const remoteBaseUrl = ref('')
const remoteApiKey = ref('')
const saveMessage = ref('')

const modelOptions = computed(() => modelStore.availableModels)
const selectedModel = computed(() => modelOptions.value.find((model) => model.id === selectedModelId.value))
const agentsForSelectedModel = computed(() => {
  const agentIds = new Set(selectedModel.value?.agents.map((agent) => agent.id) ?? [])
  if (!agentIds.size) return []
  return props.agents.filter((agent) => agentIds.has(agent.id))
})
const selectedAgent = computed(
  () => agentsForSelectedModel.value.find((agent) => agent.id === selectedAgentId.value) ?? agentsForSelectedModel.value[0]
)
const canAddLocal = computed(() => Boolean(localModelName.value.trim()) && !modelStore.saving)
const canAddRemote = computed(
  () =>
    Boolean(remoteModelName.value.trim()) &&
    Boolean(remoteBaseUrl.value.trim()) &&
    Boolean(remoteApiKey.value.trim()) &&
    !modelStore.saving
)

function sourceLabel(source: RuntimeModelOption['source']) {
  return (
    {
      env: '环境配置',
      default: '预设',
      local: '本地添加',
      remote: '远端添加'
    }[source] ?? source
  )
}

function kindLabel(kind?: RuntimeModelKind) {
  return kind === 'remote' ? '远端模型' : '本地模型'
}

function keyLabel(model: RuntimeModelOption) {
  if (model.kind === 'local') return '本地默认'
  return model.hasApiKey ? 'Key 已配置' : 'Key 未配置'
}

function fallbackAgentMarkdown(agent?: Agent) {
  if (!agent) return ''
  const tools = agent.capabilityIds.map((capabilityId) => `- ${props.capabilityName(capabilityId)}`).join('\n') || '- none'
  const tags = agent.tags?.map((tag) => `- ${tag}`).join('\n') || '- none'
  return [
    `# ${agent.name}`,
    '',
    '## Role',
    agent.role,
    '',
    '## Working Rules',
    '- Follow the user request and current task contract.',
    '- Keep changes scoped and explain risks clearly.',
    '- Ask for confirmation before high-risk or destructive actions.',
    '',
    '## Tags',
    tags,
    '',
    '## Capabilities',
    tools
  ].join('\n')
}

function agentMarkdown(agent?: Agent) {
  return agent?.profileMarkdown?.trim() || fallbackAgentMarkdown(agent)
}

function selectModel(modelId: string) {
  selectedModelId.value = modelId
  selectedAgentId.value = ''
  saveMessage.value = ''
  markdownError.value = ''
}

function selectAgent(agent: Agent) {
  selectedAgentId.value = agent.id
  markdownDraft.value = agentMarkdown(agent)
  markdownMode.value = 'edit'
  markdownDialogOpen.value = true
  markdownError.value = ''
  saveMessage.value = ''
}

function closeMarkdownDialog() {
  markdownDialogOpen.value = false
  markdownError.value = ''
}

async function switchModel(modelId: string) {
  await modelStore.switchModel(modelId)
  selectedModelId.value = modelStore.currentModelId
  saveMessage.value = '当前默认模型已切换。未单独绑定模型的 Agent 会使用它。'
}

async function bindAgentToModel(agent: Agent) {
  const modelId = selectedModel.value?.id
  if (!modelId) return
  await agentStore.updateAgent(agent.id, { modelId })
  await modelStore.loadConfig()
  saveMessage.value = `${agent.name} 已绑定到 ${selectedModel.value?.label ?? '当前模型'}。`
}

async function saveAgentMarkdown() {
  const agent = selectedAgent.value
  if (!agent) return
  const profileMarkdown = markdownDraft.value.trim()
  if (!profileMarkdown) {
    markdownError.value = '请填写 Agent Markdown 规则文档'
    return
  }

  markdownSaving.value = true
  markdownError.value = ''
  try {
    await agentStore.updateAgent(agent.id, { profileMarkdown })
    markdownDraft.value = profileMarkdown
    saveMessage.value = `${agent.name} 的 Markdown 规则已更新。`
    closeMarkdownDialog()
  } catch (error) {
    markdownError.value = error instanceof Error ? error.message : '保存 Agent Markdown 规则失败'
  } finally {
    markdownSaving.value = false
  }
}

async function addLocalModel() {
  const model = localModelName.value.trim()
  if (!model) return
  await modelStore.addModel({ kind: 'local', model })
  selectedModelId.value = modelStore.currentModelId
  localModelName.value = ''
  saveMessage.value = '本地模型已添加到模型列表。'
}

async function addRemoteModel() {
  const model = remoteModelName.value.trim()
  const baseUrl = remoteBaseUrl.value.trim()
  const apiKey = remoteApiKey.value.trim()
  if (!model || !baseUrl || !apiKey) return
  await modelStore.addModel({
    kind: 'remote',
    label: remoteLabel.value.trim() || undefined,
    model,
    baseUrl,
    apiKey
  })
  selectedModelId.value = modelStore.currentModelId
  remoteLabel.value = ''
  remoteModelName.value = ''
  remoteBaseUrl.value = ''
  remoteApiKey.value = ''
  saveMessage.value = '远端模型已添加到模型列表。'
}

const editDialogOpen = ref(false)
const editingModelId = ref('')
const editLabel = ref('')
const editModelName = ref('')
const editBaseUrl = ref('')
const editApiKey = ref('')
const editLabelInput = ref<HTMLInputElement | null>(null)
const editingModel = computed(() => modelOptions.value.find((model) => model.id === editingModelId.value))
const canSaveEdit = computed(
  () =>
    Boolean(editModelName.value.trim()) &&
    (editingModel.value?.kind !== 'remote' || Boolean(editBaseUrl.value.trim())) &&
    !modelStore.saving
)

function openEditDialog(model: RuntimeModelOption) {
  editingModelId.value = model.id
  editLabel.value = model.label
  editModelName.value = model.model
  editBaseUrl.value = model.baseUrl ?? ''
  editApiKey.value = ''
  editDialogOpen.value = true
  saveMessage.value = ''
  void nextTick(() => editLabelInput.value?.focus())
}

function closeEditDialog() {
  editDialogOpen.value = false
  editingModelId.value = ''
}

async function saveModelEdit() {
  const model = editingModel.value
  if (!model || !canSaveEdit.value) return
  const input: RuntimeModelUpdateInput = {
    label: editLabel.value,
    model: editModelName.value.trim()
  }
  if (model.kind === 'remote') {
    input.baseUrl = editBaseUrl.value.trim()
    const apiKey = editApiKey.value.trim()
    if (apiKey) {
      input.apiKey = apiKey
    }
  }
  await modelStore.updateModel(model.id, input)
  selectedModelId.value = modelStore.currentModelId
  closeEditDialog()
  saveMessage.value = '模型信息已更新。'
}

async function removeModel(model: RuntimeModelOption) {
  if (!window.confirm(`确认删除模型「${model.label}」？删除后未绑定模型的 Agent 会回落到当前默认模型。`)) return
  await modelStore.deleteModel(model.id)
  if (selectedModelId.value === model.id) {
    selectedModelId.value = modelStore.currentModelId
  }
  saveMessage.value = '模型已删除。'
}

watch(
  () => modelStore.currentModelId,
  (modelId) => {
    if (!selectedModelId.value && modelId) {
      selectedModelId.value = modelId
    }
  },
  { immediate: true }
)

watch(
  selectedAgent,
  (agent) => {
    markdownDraft.value = agentMarkdown(agent)
    markdownError.value = ''
  },
  { immediate: true }
)

watch(
  agentsForSelectedModel,
  (agents) => {
    if (!agents.some((agent) => agent.id === selectedAgentId.value)) {
      selectedAgentId.value = agents[0]?.id ?? ''
    }
  },
  { immediate: true }
)

onMounted(async () => {
  if (!modelStore.config) {
    await modelStore.loadConfig()
  }
})
</script>

<template>
  <div class="model-management model-management-cards">
    <section class="model-card-list">
      <article class="admin-card model-add-card">
        <header>
          <strong>添加模型</strong>
          <div class="model-mode-tabs">
            <button type="button" :class="{ active: addMode === 'local' }" @click="addMode = 'local'">本地</button>
            <button type="button" :class="{ active: addMode === 'remote' }" @click="addMode = 'remote'">远端</button>
          </div>
        </header>

        <div v-if="addMode === 'local'" class="model-form-grid">
          <label class="model-select-field">
            <span>模型名称</span>
            <input v-model="localModelName" type="text" placeholder="例如 llama3.2 或 qwen2.5-coder:7b" />
          </label>
          <button type="button" class="primary" :disabled="!canAddLocal" @click="addLocalModel">
            <UiIcon name="plus" :size="16" />
            添加本地模型
          </button>
        </div>

        <div v-else class="model-form-grid remote">
          <label class="model-select-field">
            <span>显示名称</span>
            <input v-model="remoteLabel" type="text" placeholder="可选，例如 OpenAI GPT-4.1 mini" />
          </label>
          <label class="model-select-field">
            <span>模型名称</span>
            <input v-model="remoteModelName" type="text" placeholder="例如 gpt-4.1-mini" />
          </label>
          <label class="model-select-field span-2">
            <span>接口地址</span>
            <input v-model="remoteBaseUrl" type="text" placeholder="例如 https://api.openai.com/v1" />
          </label>
          <label class="model-select-field span-2">
            <span>API Key</span>
            <input v-model="remoteApiKey" type="password" autocomplete="new-password" placeholder="sk-..." />
          </label>
          <button type="button" class="primary" :disabled="!canAddRemote" @click="addRemoteModel">
            <UiIcon name="plus" :size="16" />
            添加远端模型
          </button>
        </div>
      </article>

      <article
        v-for="model in modelOptions"
        :key="model.id"
        :class="['admin-card', 'model-option-card', { active: selectedModel?.id === model.id }]"
        @click="selectModel(model.id)"
      >
        <header>
          <div>
            <strong>{{ model.label }}</strong>
            <p>{{ model.model }}</p>
          </div>
          <span>{{ kindLabel(model.kind) }}</span>
        </header>
        <dl>
          <div>
            <dt>来源</dt>
            <dd>{{ sourceLabel(model.source) }}</dd>
          </div>
          <div>
            <dt>Key</dt>
            <dd>{{ keyLabel(model) }}</dd>
          </div>
          <div>
            <dt>Agent</dt>
            <dd>{{ model.agents.length }}</dd>
          </div>
        </dl>
        <div class="model-card-actions">
          <button type="button" :disabled="modelStore.saving || modelStore.currentModelId === model.id" @click.stop="switchModel(model.id)">
            <UiIcon name="check" :size="16" />
            {{ modelStore.currentModelId === model.id ? '默认模型' : '设为默认' }}
          </button>
          <button v-if="model.persisted" type="button" :disabled="modelStore.saving" @click.stop="openEditDialog(model)">
            <UiIcon name="settings" :size="16" />
            编辑
          </button>
          <button v-if="model.persisted" type="button" :disabled="modelStore.saving" @click.stop="removeModel(model)">
            <UiIcon name="trash" :size="16" />
            删除
          </button>
        </div>
      </article>
    </section>

    <section class="model-agent-detail">
      <article class="admin-card model-selected-summary">
        <header>
          <div>
            <strong>{{ selectedModel?.label ?? '未选择模型' }}</strong>
            <p>{{ selectedModel ? `${kindLabel(selectedModel.kind)} / ${sourceLabel(selectedModel.source)}` : '请选择左侧模型卡片' }}</p>
          </div>
          <span>{{ agentsForSelectedModel.length }} 个 Agent</span>
        </header>
        <p v-if="saveMessage" class="model-success">{{ saveMessage }}</p>
        <p v-if="modelStore.error" class="model-error">{{ modelStore.error }}</p>
      </article>

      <div class="model-agent-grid">
        <article
          v-for="agent in agentsForSelectedModel"
          :key="agent.id"
          :class="['admin-card', 'model-agent-card', { active: selectedAgent?.id === agent.id }]"
          @click="selectAgent(agent)"
        >
          <header>
            <div>
              <strong>{{ agent.name }}</strong>
              <p>{{ agent.role }}</p>
            </div>
            <span :class="['agent-maintenance-status', agent.status]">{{ agent.status === 'active' ? '可用' : '停用' }}</span>
          </header>
          <div class="tag-row">
            <span v-for="capabilityId in agent.capabilityIds" :key="capabilityId" class="tag">
              {{ props.capabilityName(capabilityId) }}
            </span>
            <span v-if="!agent.capabilityIds.length" class="tag muted">未配置能力</span>
          </div>
        </article>
        <p v-if="!agentsForSelectedModel.length" class="admin-empty">
          当前模型下暂无 Agent。到 Agent 管理里编辑 Agent，或选择其它模型。
        </p>
      </div>

    </section>

    <div v-if="markdownDialogOpen && selectedAgent" class="modal-backdrop" @click.self="closeMarkdownDialog">
      <form class="modal-panel model-agent-markdown-dialog" @submit.prevent="saveAgentMarkdown">
        <header>
          <div>
            <h2>{{ selectedAgent.name }}</h2>
            <p>{{ runtimeTypeLabel(selectedAgent.runtimeType) }} / {{ selectedModel?.label ?? '未配置模型' }}</p>
          </div>
          <button class="modal-close-button" type="button" @click="closeMarkdownDialog">
            <UiIcon name="x" :size="16" />
          </button>
        </header>

        <div class="model-doc-actions">
          <button type="button" @click="markdownMode = markdownMode === 'edit' ? 'preview' : 'edit'">
            {{ markdownMode === 'edit' ? '预览' : '编辑' }}
          </button>
          <button type="button" @click="bindAgentToModel(selectedAgent)">
              <UiIcon name="check" :size="16" />
              绑定到当前模型
            </button>
          <button type="submit" class="primary" :disabled="markdownSaving">
            {{ markdownSaving ? '保存中' : '保存 Markdown' }}
          </button>
        </div>

        <textarea
          v-if="markdownMode === 'edit'"
          v-model="markdownDraft"
          class="model-agent-markdown-editor"
          spellcheck="false"
        />
        <pre v-else class="model-agent-markdown-preview">{{ markdownDraft }}</pre>
        <p v-if="markdownError" class="model-error">{{ markdownError }}</p>
      </form>
    </div>

    <div v-if="editDialogOpen && editingModel" class="modal-backdrop" @click.self="closeEditDialog">
      <form
        class="modal-panel model-edit-dialog"
        @submit.prevent="saveModelEdit"
        @keydown.esc.prevent="closeEditDialog"
      >
        <header class="model-edit-head">
          <div class="model-edit-title">
            <span class="model-edit-icon"><UiIcon name="settings" :size="18" /></span>
            <div>
              <h2>编辑模型</h2>
              <p>保存后立即对新的模型调用生效</p>
            </div>
          </div>
          <button class="modal-close-button" type="button" @click="closeEditDialog">
            <UiIcon name="x" :size="16" />
          </button>
        </header>

        <div class="model-edit-context">
          <span class="model-edit-chip accent">{{ kindLabel(editingModel.kind) }}</span>
          <span class="model-edit-chip">{{ sourceLabel(editingModel.source) }}</span>
          <code>{{ editingModel.model }}</code>
        </div>

        <div class="model-edit-fields">
          <label class="model-select-field">
            <span>显示名称</span>
            <input ref="editLabelInput" v-model="editLabel" type="text" placeholder="留空则使用模型名称" />
          </label>
          <label class="model-select-field">
            <span>模型名称</span>
            <input v-model="editModelName" type="text" />
          </label>
          <template v-if="editingModel.kind === 'remote'">
            <label class="model-select-field span-2">
              <span>接口地址</span>
              <input v-model="editBaseUrl" type="text" class="model-edit-url" placeholder="例如 https://api.openai.com/v1" />
              <small>需包含完整 API 前缀（通常以 /v1 结尾），缺失时请求会落到网页而非接口。</small>
            </label>
            <label class="model-select-field span-2">
              <span>API Key</span>
              <input v-model="editApiKey" type="password" autocomplete="new-password" placeholder="留空则保持原有 Key 不变" />
            </label>
          </template>
        </div>

        <p v-if="modelStore.error" class="model-error model-edit-error">{{ modelStore.error }}</p>

        <footer class="model-edit-actions">
          <button type="button" @click="closeEditDialog">取消</button>
          <button type="submit" class="primary" :disabled="!canSaveEdit">
            {{ modelStore.saving ? '保存中…' : '保存修改' }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>
