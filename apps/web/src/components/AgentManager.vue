<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import type { Agent, RuntimeCapabilityDefinition } from '@/types/contracts'
import { runtimeTypeLabel } from '@/utils/runtimeLabels'
import UiIcon from './UiIcon.vue'

type AgentFormState = {
  name: string
  role: string
  tags: string
  modelId: string
  capabilityIds: string[]
}

const props = defineProps<{
  agents: Agent[]
  capabilities: RuntimeCapabilityDefinition[]
}>()

const agentStore = useAgentStore()
const modelStore = useRuntimeModelStore()
const showCreateForm = ref(false)
const editingAgentId = ref('')
const savingAgentId = ref('')
const formError = ref('')
const createForm = ref<AgentFormState>(emptyForm())
const editForms = ref<Record<string, AgentFormState>>({})

const activeAgentCount = computed(() => props.agents.filter((agent) => agent.status === 'active').length)
const capabilityNameById = computed(() => new Map(props.capabilities.map((capability) => [capability.id, capability.name])))

function emptyForm(): AgentFormState {
  return {
    name: '',
    role: '',
    tags: '',
    modelId: modelStore.currentModelId,
    capabilityIds: []
  }
}

function formFromAgent(agent: Agent): AgentFormState {
  return {
    name: agent.name,
    role: agent.role,
    tags: agent.tags?.join(', ') ?? '',
    modelId: agent.modelId ?? modelStore.currentModelId,
    capabilityIds: [...agent.capabilityIds]
  }
}

function normalizedTags(tags: string) {
  return Array.from(
    new Set(
      tags
        .split(/[,\n\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  )
}

function statusLabel(status: Agent['status']) {
  return status === 'active' ? '启用中' : '已停用'
}

function capabilityLabel(capabilityId: string) {
  return capabilityNameById.value.get(capabilityId) ?? capabilityId
}

function toggleCapability(form: AgentFormState, capabilityId: string) {
  form.capabilityIds = form.capabilityIds.includes(capabilityId)
    ? form.capabilityIds.filter((id) => id !== capabilityId)
    : [...form.capabilityIds, capabilityId]
}

function startCreate() {
  createForm.value = emptyForm()
  formError.value = ''
  showCreateForm.value = true
  editingAgentId.value = ''
}

function cancelCreate() {
  showCreateForm.value = false
  createForm.value = emptyForm()
  formError.value = ''
}

function startEdit(agent: Agent) {
  editForms.value = {
    ...editForms.value,
    [agent.id]: formFromAgent(agent)
  }
  formError.value = ''
  editingAgentId.value = agent.id
  showCreateForm.value = false
}

function cancelEdit() {
  editingAgentId.value = ''
  formError.value = ''
}

async function createAgent() {
  const name = createForm.value.name.trim()
  const role = createForm.value.role.trim()
  if (!name || !role) {
    formError.value = '请填写 Agent 名称和能力描述'
    return
  }

  savingAgentId.value = 'new'
  formError.value = ''
  try {
    await agentStore.createAgent({
      name,
      role,
      tags: normalizedTags(createForm.value.tags),
      modelId: createForm.value.modelId || undefined,
      capabilityIds: createForm.value.capabilityIds
    })
    cancelCreate()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '创建 Agent 失败'
  } finally {
    savingAgentId.value = ''
  }
}

async function updateAgent(agent: Agent) {
  const form = editForms.value[agent.id]
  if (!form) return
  const name = form.name.trim()
  const role = form.role.trim()
  if (!name || !role) {
    formError.value = '请填写 Agent 名称和能力描述'
    return
  }

  savingAgentId.value = agent.id
  formError.value = ''
  try {
    await agentStore.updateAgent(agent.id, {
      name,
      role,
      tags: normalizedTags(form.tags),
      modelId: form.modelId || undefined,
      capabilityIds: form.capabilityIds
    })
    cancelEdit()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '保存 Agent 失败'
  } finally {
    savingAgentId.value = ''
  }
}

async function toggleAgentStatus(agent: Agent) {
  savingAgentId.value = agent.id
  formError.value = ''
  try {
    await agentStore.updateAgent(agent.id, {
      status: agent.status === 'active' ? 'disabled' : 'active'
    })
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '更新 Agent 状态失败'
  } finally {
    savingAgentId.value = ''
  }
}

onMounted(async () => {
  if (!modelStore.config) {
    await modelStore.loadConfig()
  }
})
</script>

<template>
  <div class="agent-manager">
    <article class="admin-card agent-manager-toolbar">
      <div>
        <strong>Agent 列表维护</strong>
        <p>维护 Agent 成员、职责说明、标签、可用能力和启停状态。</p>
      </div>
      <dl>
        <div>
          <dt>总数</dt>
          <dd>{{ agents.length }}</dd>
        </div>
        <div>
          <dt>启用</dt>
          <dd>{{ activeAgentCount }}</dd>
        </div>
      </dl>
      <button type="button" class="primary" @click="startCreate">
        <UiIcon name="plus" :size="16" />
        新建 Agent
      </button>
    </article>

    <form v-if="showCreateForm" class="admin-card agent-maintenance-form" @submit.prevent="createAgent">
      <header>
        <strong>新建 Agent</strong>
        <button type="button" @click="cancelCreate">
          <UiIcon name="x" :size="16" />
          取消
        </button>
      </header>
      <label>
        <span>名称</span>
        <input v-model="createForm.name" type="text" placeholder="例如 数据分析 Agent" />
      </label>
      <label>
        <span>标签</span>
        <input v-model="createForm.tags" type="text" placeholder="例如 data, report" />
      </label>
      <label>
        <span>归属模型</span>
        <select v-model="createForm.modelId">
          <option value="">跟随默认模型</option>
          <option v-for="model in modelStore.availableModels" :key="model.id" :value="model.id">
            {{ model.label }}
          </option>
        </select>
      </label>
      <label class="span-2">
        <span>能力描述</span>
        <textarea v-model="createForm.role" rows="3" placeholder="说明这个 Agent 负责什么，以及适合处理哪些任务" />
      </label>
      <div class="agent-capability-editor span-2">
        <span>可用能力</span>
        <button
          v-for="capability in capabilities"
          :key="capability.id"
          type="button"
          :class="{ selected: createForm.capabilityIds.includes(capability.id) }"
          @click="toggleCapability(createForm, capability.id)"
        >
          {{ capability.name }}
        </button>
      </div>
      <p v-if="formError" class="form-error span-2">{{ formError }}</p>
      <footer class="form-actions span-2">
        <button type="button" @click="cancelCreate">取消</button>
        <button type="submit" class="primary" :disabled="savingAgentId === 'new'">
          {{ savingAgentId === 'new' ? '创建中' : '创建 Agent' }}
        </button>
      </footer>
    </form>

    <section class="agent-maintenance-list">
      <article v-for="agent in agents" :key="agent.id" class="admin-card agent-maintenance-card">
        <template v-if="editingAgentId === agent.id && editForms[agent.id]">
          <form class="agent-maintenance-edit" @submit.prevent="updateAgent(agent)">
            <label>
              <span>名称</span>
              <input v-model="editForms[agent.id].name" type="text" />
            </label>
            <label>
              <span>标签</span>
              <input v-model="editForms[agent.id].tags" type="text" />
            </label>
            <label>
              <span>归属模型</span>
              <select v-model="editForms[agent.id].modelId">
                <option value="">跟随默认模型</option>
                <option v-for="model in modelStore.availableModels" :key="model.id" :value="model.id">
                  {{ model.label }}
                </option>
              </select>
            </label>
            <label class="span-2">
              <span>能力描述</span>
              <textarea v-model="editForms[agent.id].role" rows="3" />
            </label>
            <div class="agent-capability-editor span-2">
              <span>可用能力</span>
              <button
                v-for="capability in capabilities"
                :key="capability.id"
                type="button"
                :class="{ selected: editForms[agent.id].capabilityIds.includes(capability.id) }"
                @click="toggleCapability(editForms[agent.id], capability.id)"
              >
                {{ capability.name }}
              </button>
            </div>
            <p v-if="formError" class="form-error span-2">{{ formError }}</p>
            <footer class="form-actions span-2">
              <button type="button" @click="cancelEdit">取消</button>
              <button type="submit" class="primary" :disabled="savingAgentId === agent.id">
                {{ savingAgentId === agent.id ? '保存中' : '保存 Agent' }}
              </button>
            </footer>
          </form>
        </template>

        <template v-else>
          <header>
            <div>
              <strong>{{ agent.name }}</strong>
              <p>{{ agent.role }}</p>
            </div>
            <span :class="['agent-maintenance-status', agent.status]">{{ statusLabel(agent.status) }}</span>
          </header>
          <dl>
            <div>
              <dt>运行时</dt>
              <dd>{{ runtimeTypeLabel(agent.runtimeType) }}</dd>
            </div>
            <div>
              <dt>Key</dt>
              <dd>{{ agent.key }}</dd>
            </div>
            <div>
              <dt>归属模型</dt>
              <dd>{{ modelStore.availableModels.find((model) => model.id === (agent.modelId ?? modelStore.currentModelId))?.label ?? '跟随默认模型' }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ agent.updatedAt }}</dd>
            </div>
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
        </template>
      </article>
      <p v-if="!agents.length" class="admin-empty">暂无 Agent，请先新建 Agent。</p>
    </section>
  </div>
</template>
