<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useModelStore } from '@/stores/model'
import type { ModelConnection, ModelDefinition, ModelProvider, ModelSource } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const store = useModelStore()

const sourceLabels: Record<ModelSource, string> = { local: '本地', official: '官方', custom: '自建' }
const providerLabels: Record<ModelProvider, string> = {
  'openai-compatible': 'OpenAI 兼容',
  ollama: 'Ollama',
  anthropic: 'Anthropic'
}

const panelError = ref('')

onMounted(async () => {
  try {
    await store.loadAll()
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '加载模型数据失败'
  }
})

// --- connections ---
const showConnForm = ref(false)
const savingConn = ref(false)
const connError = ref('')
const connForm = reactive({
  name: '',
  source: 'local' as ModelSource,
  provider: 'ollama' as ModelProvider,
  baseUrl: '',
  credential: ''
})
const baseUrlPlaceholder = computed(() =>
  connForm.source === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1'
)

function resetConnForm() {
  connForm.name = ''
  connForm.source = 'local'
  connForm.provider = 'ollama'
  connForm.baseUrl = ''
  connForm.credential = ''
  connError.value = ''
}

function toggleConnForm() {
  showConnForm.value = !showConnForm.value
  if (!showConnForm.value) {
    resetConnForm()
  }
}

async function submitConn() {
  if (!connForm.name.trim()) {
    connError.value = '请填写连接名称'
    return
  }
  if (!connForm.baseUrl.trim()) {
    connError.value = '请填写 Base URL'
    return
  }
  if (connForm.source === 'official' && !connForm.credential.trim()) {
    connError.value = '官方来源必须填写 API Key'
    return
  }

  savingConn.value = true
  connError.value = ''
  try {
    await store.createConnection({
      name: connForm.name.trim(),
      source: connForm.source,
      provider: connForm.provider,
      baseUrl: connForm.baseUrl.trim(),
      credential: connForm.source === 'local' ? undefined : connForm.credential.trim() || undefined
    })
    resetConnForm()
    showConnForm.value = false
  } catch (error) {
    connError.value = error instanceof Error ? error.message : '创建连接失败'
  } finally {
    savingConn.value = false
  }
}

async function removeConnection(connection: ModelConnection) {
  if (!window.confirm(`确定删除连接“${connection.name}”吗？其下的模型也会一并移除。`)) {
    return
  }
  try {
    await store.deleteConnection(connection.id)
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '删除连接失败'
  }
}

// --- discover ---
const discovering = ref('')
const discovered = reactive<Record<string, string[]>>({})
const discoverError = reactive<Record<string, string>>({})

async function runDiscover(id: string) {
  discovering.value = id
  delete discoverError[id]
  try {
    discovered[id] = await store.discoverModels(id)
  } catch (error) {
    discoverError[id] = error instanceof Error ? error.message : '拉取失败'
  } finally {
    discovering.value = ''
  }
}

function hasModel(connectionId: string, upstreamModel: string) {
  return store.models.some((model) => model.connectionId === connectionId && model.upstreamModel === upstreamModel)
}

async function addDiscovered(connectionId: string, upstreamModel: string) {
  try {
    await store.createModel({ connectionId, upstreamModel, name: upstreamModel })
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '添加模型失败'
  }
}

// --- models ---
const showModelForm = ref(false)
const savingModel = ref(false)
const modelError = ref('')
const modelForm = reactive({
  connectionId: '',
  upstreamModel: '',
  name: '',
  toolCalling: true,
  vision: false,
  jsonMode: true
})

function resetModelForm() {
  modelForm.connectionId = ''
  modelForm.upstreamModel = ''
  modelForm.name = ''
  modelForm.toolCalling = true
  modelForm.vision = false
  modelForm.jsonMode = true
  modelError.value = ''
}

function toggleModelForm() {
  showModelForm.value = !showModelForm.value
  if (!showModelForm.value) {
    resetModelForm()
  }
}

async function submitModel() {
  if (!modelForm.connectionId) {
    modelError.value = '请选择连接'
    return
  }
  if (!modelForm.upstreamModel.trim()) {
    modelError.value = '请填写模型标识'
    return
  }

  savingModel.value = true
  modelError.value = ''
  try {
    await store.createModel({
      connectionId: modelForm.connectionId,
      upstreamModel: modelForm.upstreamModel.trim(),
      name: modelForm.name.trim() || undefined,
      features: { toolCalling: modelForm.toolCalling, vision: modelForm.vision, jsonMode: modelForm.jsonMode }
    })
    resetModelForm()
    showModelForm.value = false
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : '创建模型失败'
  } finally {
    savingModel.value = false
  }
}

async function removeModel(model: ModelDefinition) {
  if (!window.confirm(`确定删除模型“${model.name}”吗？`)) {
    return
  }
  try {
    await store.deleteModel(model.id)
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '删除模型失败'
  }
}
</script>

<template>
  <div class="model-admin">
    <p v-if="panelError" class="form-error">{{ panelError }}</p>

    <section class="model-section">
      <header class="admin-header">
        <div>
          <h1>模型管理</h1>
          <p>管理模型连接（本地 / 官方 / 自建）与其下的模型；凭据加密存储，不回显明文。</p>
        </div>
        <div class="admin-header-actions">
          <span class="admin-count">{{ store.connections.length }} 个连接</span>
          <button class="panel-action-button primary" type="button" @click="toggleConnForm">
            <UiIcon name="plus" :size="15" />
            添加连接
          </button>
        </div>
      </header>

      <form v-if="showConnForm" class="agent-create-form admin-agent-form" @submit.prevent="submitConn">
        <label>
          <span>名称</span>
          <input v-model="connForm.name" type="text" placeholder="OpenAI 官方 / 本地 Ollama" />
        </label>
        <label>
          <span>来源</span>
          <select v-model="connForm.source">
            <option value="local">本地</option>
            <option value="official">官方（带 API Key）</option>
            <option value="custom">自建 / 第三方</option>
          </select>
        </label>
        <label>
          <span>协议</span>
          <select v-model="connForm.provider">
            <option value="openai-compatible">OpenAI 兼容</option>
            <option value="ollama">Ollama</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>
          <span>Base URL</span>
          <input v-model="connForm.baseUrl" type="text" :placeholder="baseUrlPlaceholder" />
        </label>
        <label v-if="connForm.source !== 'local'">
          <span>API Key{{ connForm.source === 'official' ? '（必填）' : '（可选）' }}</span>
          <input v-model="connForm.credential" type="password" placeholder="sk-..." autocomplete="off" />
        </label>
        <p v-else class="field-hint">本地来源无需 API Key。</p>
        <p v-if="connError" class="form-error">{{ connError }}</p>
        <div class="form-actions">
          <button type="button" @click="toggleConnForm">取消</button>
          <button type="submit" class="primary" :disabled="savingConn">{{ savingConn ? '保存中' : '创建连接' }}</button>
        </div>
      </form>

      <div class="admin-grid">
        <article v-for="connection in store.connections" :key="connection.id" class="admin-card">
          <header>
            <strong>{{ connection.name }}</strong>
            <span :class="['source-badge', connection.source]">{{ sourceLabels[connection.source] }}</span>
          </header>
          <dl>
            <div>
              <dt>协议</dt>
              <dd>{{ providerLabels[connection.provider] }}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd class="mono">{{ connection.baseUrl || '—' }}</dd>
            </div>
            <div>
              <dt>凭据</dt>
              <dd>{{ connection.hasCredential ? '已配置（加密）' : connection.source === 'local' ? '无需' : '未配置' }}</dd>
            </div>
          </dl>
          <div v-if="discovered[connection.id]" class="discover-list">
            <span class="discover-title">可用模型</span>
            <p v-if="!discovered[connection.id].length" class="admin-empty small">未发现模型。</p>
            <button
              v-for="upstream in discovered[connection.id]"
              :key="upstream"
              type="button"
              class="discover-chip"
              :disabled="hasModel(connection.id, upstream)"
              @click="addDiscovered(connection.id, upstream)"
            >
              <UiIcon name="plus" :size="12" />
              {{ upstream }}
            </button>
          </div>
          <p v-if="discoverError[connection.id]" class="form-error">{{ discoverError[connection.id] }}</p>
          <footer class="admin-card-actions">
            <button
              class="panel-action-button"
              type="button"
              :disabled="discovering === connection.id"
              @click="runDiscover(connection.id)"
            >
              <UiIcon name="search" :size="14" />
              {{ discovering === connection.id ? '拉取中' : '拉取模型' }}
            </button>
            <button
              v-if="!connection.isDefault"
              class="panel-action-button danger"
              type="button"
              @click="removeConnection(connection)"
            >
              <UiIcon name="trash" :size="14" />
              删除
            </button>
            <span v-else class="default-pill">默认 · 环境管理</span>
          </footer>
        </article>
        <p v-if="!store.connections.length" class="admin-empty">暂无连接。</p>
      </div>
    </section>

    <section class="model-section">
      <header class="admin-header">
        <div>
          <h1>模型</h1>
          <p>每个模型挂在一个连接下，Agent 运行时按所选模型调用。</p>
        </div>
        <div class="admin-header-actions">
          <span class="admin-count">{{ store.models.length }} 个模型</span>
          <button
            class="panel-action-button primary"
            type="button"
            :disabled="!store.connections.length"
            @click="toggleModelForm"
          >
            <UiIcon name="plus" :size="15" />
            添加模型
          </button>
        </div>
      </header>

      <form v-if="showModelForm" class="agent-create-form admin-agent-form" @submit.prevent="submitModel">
        <label>
          <span>连接</span>
          <select v-model="modelForm.connectionId">
            <option value="" disabled>选择连接</option>
            <option v-for="connection in store.connections" :key="connection.id" :value="connection.id">
              {{ connection.name }}
            </option>
          </select>
        </label>
        <label>
          <span>模型标识（upstream）</span>
          <input v-model="modelForm.upstreamModel" type="text" placeholder="gpt-4.1-mini / qwen2.5:7b" />
        </label>
        <label>
          <span>显示名（可选）</span>
          <input v-model="modelForm.name" type="text" placeholder="留空则用模型标识" />
        </label>
        <div class="agent-capability-picker">
          <span>能力</span>
          <button type="button" :class="{ selected: modelForm.toolCalling }" @click="modelForm.toolCalling = !modelForm.toolCalling">
            工具调用
          </button>
          <button type="button" :class="{ selected: modelForm.vision }" @click="modelForm.vision = !modelForm.vision">
            视觉
          </button>
          <button type="button" :class="{ selected: modelForm.jsonMode }" @click="modelForm.jsonMode = !modelForm.jsonMode">
            JSON 模式
          </button>
        </div>
        <p v-if="modelError" class="form-error">{{ modelError }}</p>
        <div class="form-actions">
          <button type="button" @click="toggleModelForm">取消</button>
          <button type="submit" class="primary" :disabled="savingModel">{{ savingModel ? '保存中' : '创建模型' }}</button>
        </div>
      </form>

      <div class="admin-grid">
        <article v-for="model in store.models" :key="model.id" class="admin-card">
          <header>
            <strong>{{ model.name }}</strong>
            <span class="conn-badge">{{ store.connectionName(model.connectionId) }}</span>
          </header>
          <dl>
            <div>
              <dt>模型标识</dt>
              <dd class="mono">{{ model.upstreamModel }}</dd>
            </div>
          </dl>
          <div class="tag-row">
            <span v-if="model.features.toolCalling" class="tag">工具调用</span>
            <span v-if="model.features.vision" class="tag">视觉</span>
            <span v-if="model.features.jsonMode" class="tag">JSON</span>
          </div>
          <footer class="admin-card-actions">
            <button v-if="!model.isDefault" class="panel-action-button danger" type="button" @click="removeModel(model)">
              <UiIcon name="trash" :size="14" />
              删除
            </button>
            <span v-else class="default-pill">默认 · 环境管理</span>
          </footer>
        </article>
        <p v-if="!store.models.length" class="admin-empty">暂无模型。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.model-admin {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
.model-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  word-break: break-all;
}
.source-badge {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  border: 1px solid currentColor;
}
.source-badge.local {
  color: #2f9e6f;
}
.source-badge.official {
  color: #c07a1f;
}
.source-badge.custom {
  color: #5b6cff;
}
.conn-badge {
  font-size: 0.75rem;
  opacity: 0.75;
}
.discover-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  margin-top: 0.5rem;
}
.discover-title {
  width: 100%;
  font-size: 0.78rem;
  opacity: 0.7;
}
.discover-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  border: 1px dashed var(--border, #d0d3e0);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.8rem;
}
.discover-chip:disabled {
  opacity: 0.45;
  cursor: default;
}
.default-pill {
  font-size: 0.75rem;
  opacity: 0.6;
}
.field-hint {
  font-size: 0.8rem;
  opacity: 0.7;
}
.admin-empty.small {
  font-size: 0.8rem;
  opacity: 0.6;
}
</style>
