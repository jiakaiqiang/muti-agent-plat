<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import { useLocalRuntimeStore } from '@/stores/localRuntime'
import type { RuntimeModelKind, RuntimeModelOption, RuntimeModelProvider, RuntimeModelUpdateInput } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const modelStore = useRuntimeModelStore()
const localRuntimeStore = useLocalRuntimeStore()
const {
  selectedModelId,
  addMode,
  localModelName,
  remoteLabel,
  remoteModelName,
  remoteBaseUrl,
  remoteApiKey,
  remoteInputPerMillion,
  remoteOutputPerMillion,
  remotePriceVersion,
  saveMessage,
  editDialogOpen,
  editingModelId,
  editLabel,
  editModelName,
  editBaseUrl,
  editApiKey,
  editInputPerMillion,
  editOutputPerMillion,
  editPriceVersion
} = storeToRefs(modelStore)

const modelOptions = computed(() => modelStore.availableModels)
const remoteProvider = ref<Extract<RuntimeModelProvider, 'openai-compatible' | 'anthropic-compatible'>>('openai-compatible')
const remoteCredentialLocation = ref<'server' | 'local'>('server')
const remoteDeviceId = ref('')
const localDevices = computed(() => localRuntimeStore.devices.filter((device) => device.connected))
const selectedModel = computed(() => modelOptions.value.find((model) => model.id === selectedModelId.value))
const canAddLocal = computed(() => Boolean(localModelName.value.trim()) && !modelStore.saving)
const hasPartialRemotePricing = computed(() =>
  (pricingFieldText(remoteInputPerMillion.value) === '') !== (pricingFieldText(remoteOutputPerMillion.value) === '')
)
const canAddRemote = computed(
  () =>
    Boolean(remoteModelName.value.trim()) &&
    Boolean(remoteBaseUrl.value.trim()) &&
    Boolean(remoteApiKey.value.trim()) &&
    (remoteCredentialLocation.value === 'server' || Boolean(remoteDeviceId.value)) &&
    ((pricingFieldText(remoteInputPerMillion.value) === '' && pricingFieldText(remoteOutputPerMillion.value) === '') || (isNonNegativeNumber(remoteInputPerMillion.value) && isNonNegativeNumber(remoteOutputPerMillion.value))) &&
    !modelStore.saving
)

function pricingFieldText(value: string | number) {
  return String(value).trim()
}

function isNonNegativeNumber(value: string | number) {
  const normalized = pricingFieldText(value)
  const parsed = Number(normalized)
  return normalized !== '' && Number.isFinite(parsed) && parsed >= 0
}

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

function selectModel(modelId: string) {
  selectedModelId.value = modelId
  saveMessage.value = ''
}

async function runModelRequest(request: () => Promise<void>) {
  saveMessage.value = ''
  try {
    await request()
    return true
  } catch {
    // The domain store owns the user-visible error state.
    return false
  }
}

async function switchModel(modelId: string) {
  if (!await runModelRequest(() => modelStore.switchModel(modelId))) return
  selectedModelId.value = modelStore.currentModelId
  saveMessage.value = '当前默认模型已切换。仅影响之后新建的 Session。'
}

async function addLocalModel() {
  const model = localModelName.value.trim()
  if (!model) return
  if (!await runModelRequest(() => modelStore.addModel({ kind: 'local', model }))) return
  selectedModelId.value = modelStore.currentModelId
  localModelName.value = ''
  saveMessage.value = '本地模型已添加到模型列表。'
}

async function addRemoteModel() {
  const model = remoteModelName.value.trim()
  const baseUrl = remoteBaseUrl.value.trim()
  const apiKey = remoteApiKey.value.trim()
  if (!model || !baseUrl || !apiKey) return
  const hasPricing = pricingFieldText(remoteInputPerMillion.value) !== '' && pricingFieldText(remoteOutputPerMillion.value) !== ''
  const priceVersion = remotePriceVersion.value.trim()
  const added = await runModelRequest(() => modelStore.addModel({
    kind: 'remote',
    label: remoteLabel.value.trim() || undefined,
    model,
    baseUrl,
    apiKey,
    provider: remoteProvider.value,
    credentialLocation: remoteCredentialLocation.value,
    ...(hasPricing ? {
      inputPerMillion: Number(pricingFieldText(remoteInputPerMillion.value)),
      outputPerMillion: Number(pricingFieldText(remoteOutputPerMillion.value)),
      ...(priceVersion ? { priceVersion } : {})
    } : {}),
    ...(remoteCredentialLocation.value === 'local' ? { deviceId: remoteDeviceId.value } : {})
  }))
  if (!added) return
  selectedModelId.value = modelStore.currentModelId
  remoteLabel.value = ''
  remoteModelName.value = ''
  remoteBaseUrl.value = ''
  remoteApiKey.value = ''
  remoteInputPerMillion.value = ''
  remoteOutputPerMillion.value = ''
  remotePriceVersion.value = ''
  remoteDeviceId.value = ''
  saveMessage.value = '远端模型已添加到模型列表。'
}

const editLabelInput = ref<HTMLInputElement | null>(null)
const editingModel = computed(() => modelOptions.value.find((model) => model.id === editingModelId.value))
const hasPartialEditPricing = computed(() =>
  (pricingFieldText(editInputPerMillion.value) === '') !== (pricingFieldText(editOutputPerMillion.value) === '')
)
const canSaveEdit = computed(
  () =>
    Boolean(editModelName.value.trim()) &&
    (editingModel.value?.kind !== 'remote' || Boolean(editBaseUrl.value.trim())) &&
    (editingModel.value?.kind !== 'remote' ||
      ((pricingFieldText(editInputPerMillion.value) === '' && pricingFieldText(editOutputPerMillion.value) === '') ||
        (isNonNegativeNumber(editInputPerMillion.value) && isNonNegativeNumber(editOutputPerMillion.value)))) &&
    !modelStore.saving
)

function openEditDialog(model: RuntimeModelOption) {
  editingModelId.value = model.id
  editLabel.value = model.label
  editModelName.value = model.model
  editBaseUrl.value = model.baseUrl ?? ''
  editApiKey.value = ''
  editInputPerMillion.value = model.pricing?.inputPerMillion?.toString() ?? ''
  editOutputPerMillion.value = model.pricing?.outputPerMillion?.toString() ?? ''
  editPriceVersion.value = model.pricing?.priceVersion ?? ''
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
    const hasPricing = pricingFieldText(editInputPerMillion.value) !== '' && pricingFieldText(editOutputPerMillion.value) !== ''
    if (hasPricing) {
      input.inputPerMillion = Number(pricingFieldText(editInputPerMillion.value))
      input.outputPerMillion = Number(pricingFieldText(editOutputPerMillion.value))
      const priceVersion = editPriceVersion.value.trim()
      if (priceVersion && priceVersion !== model.pricing?.priceVersion) input.priceVersion = priceVersion
    } else if (model.pricing) {
      input.inputPerMillion = null
      input.outputPerMillion = null
    }
  }
  if (!await runModelRequest(() => modelStore.updateModel(model.id, input))) return
  selectedModelId.value = modelStore.currentModelId
  closeEditDialog()
  saveMessage.value = '模型信息已更新。'
}

async function removeModel(model: RuntimeModelOption) {
  if (!window.confirm(`确认删除模型「${model.label}」？删除后新建 Session 会回落到当前默认模型。`)) return
  if (!await runModelRequest(() => modelStore.deleteModel(model.id))) return
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

onMounted(async () => {
  if (!modelStore.config) {
    await modelStore.loadConfig()
  }
  await localRuntimeStore.loadDevices().catch(() => undefined)
})
</script>

<template>
  <div class="model-management model-management-cards">
    <article class="admin-card model-manager-intro">
      <div>
        <strong>模型管理</strong>
        <p>只负责模型 CRUD、默认切换和连接状态。Agent 能力编辑与模型绑定已迁移到 Agent 管理页。</p>
      </div>
      <p v-if="saveMessage" class="model-success">{{ saveMessage }}</p>
      <p v-if="modelStore.error" class="model-error">{{ modelStore.error }}</p>
    </article>

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
          <label class="model-select-field">
            <span>接口协议</span>
            <select v-model="remoteProvider">
              <option value="openai-compatible">OpenAI compatible (Codex)</option>
              <option value="anthropic-compatible">Anthropic compatible (Claude Code)</option>
            </select>
          </label>
          <label class="model-select-field">
            <span>凭据位置</span>
            <select v-model="remoteCredentialLocation">
              <option value="server">服务器</option>
              <option value="local">本机 Local Runtime</option>
            </select>
          </label>
          <label v-if="remoteCredentialLocation === 'local'" class="model-select-field span-2">
            <span>本机设备</span>
            <select v-model="remoteDeviceId">
              <option value="">选择已连接设备</option>
              <option v-for="device in localDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.displayName }}
              </option>
            </select>
          </label>
          <label class="model-select-field span-2">
            <span>接口地址</span>
            <input v-model="remoteBaseUrl" type="text" placeholder="例如 https://api.openai.com/v1" />
          </label>
          <label class="model-select-field span-2">
            <span>API Key</span>
            <input v-model="remoteApiKey" type="password" autocomplete="new-password" placeholder="sk-..." />
          </label>
          <label class="model-select-field">
            <span>输入价格（USD / 1M tokens）</span>
            <input v-model="remoteInputPerMillion" data-testid="remote-input-price" type="number" min="0" step="any" placeholder="可选，例如 0.10" aria-describedby="remote-price-hint" :aria-invalid="hasPartialRemotePricing" />
          </label>
          <label class="model-select-field">
            <span>输出价格（USD / 1M tokens）</span>
            <input v-model="remoteOutputPerMillion" data-testid="remote-output-price" type="number" min="0" step="any" placeholder="可选，例如 0.20" aria-describedby="remote-price-hint" :aria-invalid="hasPartialRemotePricing" />
          </label>
          <label class="model-select-field span-2">
            <span>价格版本</span>
            <input v-model="remotePriceVersion" type="text" placeholder="可选，例如 relay-pricing-2026-09" />
            <small id="remote-price-hint" aria-live="polite">{{ hasPartialRemotePricing ? '输入价格和输出价格需要一起填写。' : '本地中转的实际费率由你配置；未填写时费用保持未知。' }}</small>
          </label>
          <button type="button" class="primary" data-testid="add-remote-model" :disabled="!canAddRemote" @click="addRemoteModel">
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
            <dt>协议</dt>
            <dd>{{ model.provider }}</dd>
          </div>
          <div>
            <dt>凭据</dt>
            <dd>{{ model.credentialLocation === 'local' ? '本机设备' : '服务器' }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ modelStore.currentModelId === model.id ? '默认模型' : '可用' }}</dd>
          </div>
          <div v-if="model.kind === 'remote'" class="model-pricing-summary">
            <dt>价格</dt>
            <dd v-if="model.pricing">
              输入 ${{ model.pricing.inputPerMillion }} / 1M · 输出 ${{ model.pricing.outputPerMillion }} / 1M
            </dd>
            <dd v-else data-testid="pricing-unknown">未配置，费用未知</dd>
          </div>
        </dl>
        <div class="model-card-actions">
          <button type="button" :disabled="modelStore.saving || modelStore.currentModelId === model.id" @click.stop="switchModel(model.id)">
            <UiIcon name="check" :size="16" />
            {{ modelStore.currentModelId === model.id ? '默认模型' : '设为默认' }}
          </button>
          <button v-if="model.persisted" data-testid="edit-model" type="button" :disabled="modelStore.saving" @click.stop="openEditDialog(model)">
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

    <div v-if="editDialogOpen && editingModel" class="modal-backdrop" @click.self="closeEditDialog">
      <form
        class="modal-panel model-edit-dialog"
        data-testid="model-edit-form"
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
              <input v-model="editApiKey" data-testid="edit-api-key" type="password" autocomplete="new-password" placeholder="留空则保持原有 Key 不变" />
            </label>
            <label class="model-select-field">
              <span>输入价格（USD / 1M tokens）</span>
              <input v-model="editInputPerMillion" data-testid="edit-input-price" type="number" min="0" step="any" placeholder="例如 0.10" aria-describedby="edit-price-hint" :aria-invalid="hasPartialEditPricing" />
            </label>
            <label class="model-select-field">
              <span>输出价格（USD / 1M tokens）</span>
              <input v-model="editOutputPerMillion" data-testid="edit-output-price" type="number" min="0" step="any" placeholder="例如 0.20" aria-describedby="edit-price-hint" :aria-invalid="hasPartialEditPricing" />
            </label>
            <label class="model-select-field span-2">
              <span>价格版本</span>
              <input v-model="editPriceVersion" type="text" placeholder="例如 relay-pricing-2026-09" />
              <small id="edit-price-hint" aria-live="polite">{{ hasPartialEditPricing ? '输入价格和输出价格需要一起填写或一起清空。' : '同时清空输入价和输出价并保存，可移除模型级价格。' }}</small>
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
