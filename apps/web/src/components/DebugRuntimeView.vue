<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiGet } from '@/api/client'
import type { CollaborationEvent } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

type DebugContextPack = {
  systemRules?: string[]
  sessionGoal?: string
  taskBrief?: {
    goal?: string
    constraints?: string[]
    acceptanceCriteria?: string[]
  }
  currentTask?: {
    title?: string
    status?: string
  }
  agentProfile?: {
    key?: string
    name?: string
    role?: string
  }
  relevantEvents?: unknown[]
  relevantMemories?: Array<{
    id: string
    scope: string
    content: string
    confidence: number
  }>
  ragSnippets?: Array<{
    chunkId?: string
    title?: string
    snippet?: string
    score?: number
  }>
  artifacts?: unknown[]
  capabilities?: Array<{
    id: string
    key: string
    name: string
    riskLevel: string
  }>
  constraints?: string[]
  budget?: Record<string, unknown>
}

type ContextPackItem = {
  invocationId: string
  runId: string
  taskId?: string
  agentId: string
  agentKey: string
  phase: string
  status: string
  contextPack: DebugContextPack
  createdAt: string
}

type RuntimeInvocationItem = {
  id: string
  runId: string
  taskId?: string
  agentId: string
  agentKey: string
  runtimeType: string
  phase: string
  status: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    model?: string
  }
  startedAt: string
  completedAt: string
  contextPackSummary: {
    sessionGoal: string
    agentKey: string
    eventCount: number
    memoryCount: number
    ragSnippetCount: number
    artifactCount: number
    capabilityCount: number
    constraintCount: number
  }
}

type RagRetrievalItem = {
  eventId: string
  taskId?: string
  agentId?: string
  content: string
  payload?: {
    query?: string
    matchedChunks?: Array<{
      chunkId?: string
      title?: string
      snippet?: string
      score?: number
    }>
  }
  createdAt: string
}

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  invocationCount: number
  byInvocation: Array<{
    invocationId: string
    runId: string
    agentKey: string
    phase: string
    usage?: RuntimeInvocationItem['usage']
  }>
}

const props = defineProps<{
  sessionId: string
  events: CollaborationEvent[]
}>()

const loading = ref(false)
const error = ref('')
const selectedInvocationId = ref('')
const contextPacks = ref<ContextPackItem[]>([])
const invocations = ref<RuntimeInvocationItem[]>([])
const ragRetrievals = ref<RagRetrievalItem[]>([])
const tokenUsage = ref<TokenUsage>({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  invocationCount: 0,
  byInvocation: []
})

const selectedContextPack = computed(() => {
  if (!contextPacks.value.length) return undefined
  return contextPacks.value.find((item) => item.invocationId === selectedInvocationId.value) ?? contextPacks.value.at(-1)
})
const selectedInvocation = computed(() =>
  invocations.value.find((item) => item.id === selectedContextPack.value?.invocationId)
)
const memoryCount = computed(() =>
  contextPacks.value.reduce((total, item) => total + (item.contextPack.relevantMemories?.length ?? 0), 0)
)
const ragChunkCount = computed(() =>
  ragRetrievals.value.reduce((total, item) => total + (item.payload?.matchedChunks?.length ?? 0), 0)
)
const runtimeEventCount = computed(() => props.events.filter((event) => event.type.startsWith('runtime_')).length)
const latestUpdatedAt = computed(() => {
  const value = [...contextPacks.value.map((item) => item.createdAt), ...ragRetrievals.value.map((item) => item.createdAt)]
    .filter(Boolean)
    .sort()
    .at(-1)
  return value ? new Date(value).toLocaleTimeString() : '未同步'
})

async function loadDebugData() {
  if (!props.sessionId) return
  loading.value = true
  error.value = ''
  try {
    const [contextPackPage, invocationPage, ragPage, tokenData] = await Promise.all([
      apiGet<{ items: ContextPackItem[] }>(`/sessions/${props.sessionId}/debug/context-packs`),
      apiGet<{ items: RuntimeInvocationItem[] }>(`/sessions/${props.sessionId}/debug/runtime-invocations`),
      apiGet<{ items: RagRetrievalItem[] }>(`/sessions/${props.sessionId}/debug/rag-retrievals`),
      apiGet<TokenUsage>(`/sessions/${props.sessionId}/debug/token-usage`)
    ])
    contextPacks.value = contextPackPage.items
    invocations.value = invocationPage.items
    ragRetrievals.value = ragPage.items
    tokenUsage.value = tokenData
    selectedInvocationId.value = contextPackPage.items.at(-1)?.invocationId ?? ''
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '调试数据加载失败'
  } finally {
    loading.value = false
  }
}

function phaseLabel(phase: string) {
  return (
    {
      brief_generation: '契约生成',
      task_execution: '任务执行',
      post_review: '复盘',
      final_delivery: '最终交付',
      user_message_routing: '消息路由'
    }[phase] ?? phase
  )
}

function percent(value?: number) {
  if (value === undefined) return '-'
  return `${Math.round(value * 100)}%`
}

watch(() => props.sessionId, loadDebugData, { immediate: true })
</script>

<template>
  <section class="debug-view">
    <header class="debug-topbar">
      <div>
        <h2>Context Pack 调试台</h2>
        <p>Runtime、Memory、RAG、Token</p>
      </div>
      <div class="debug-actions">
        <span>{{ latestUpdatedAt }}</span>
        <button type="button" :disabled="loading || !sessionId" @click="loadDebugData">
          <UiIcon name="debug" :size="16" />
          刷新
        </button>
      </div>
    </header>

    <div v-if="error" class="debug-error">{{ error }}</div>

    <section class="debug-metrics" aria-label="Debug metrics">
      <article>
        <span>Runtime 调用</span>
        <strong>{{ invocations.length }}</strong>
        <small>{{ runtimeEventCount }} 个事件</small>
      </article>
      <article>
        <span>Memory 注入</span>
        <strong>{{ memoryCount }}</strong>
        <small>{{ contextPacks.length }} 个 Context Pack</small>
      </article>
      <article>
        <span>RAG 命中</span>
        <strong>{{ ragChunkCount }}</strong>
        <small>{{ ragRetrievals.length }} 次检索</small>
      </article>
      <article>
        <span>Token</span>
        <strong>{{ tokenUsage.totalTokens }}</strong>
        <small>{{ tokenUsage.invocationCount }} 次统计</small>
      </article>
    </section>

    <div class="debug-layout">
      <aside class="debug-invocation-list">
        <button
          v-for="item in contextPacks"
          :key="item.invocationId"
          type="button"
          :class="{ active: item.invocationId === selectedContextPack?.invocationId }"
          @click="selectedInvocationId = item.invocationId"
        >
          <span>{{ phaseLabel(item.phase) }}</span>
          <strong>{{ item.agentKey }}</strong>
          <small>{{ item.status }}</small>
        </button>
        <p v-if="!contextPacks.length">暂无 Context Pack</p>
      </aside>

      <main class="debug-detail">
        <section class="debug-panel debug-context-panel">
          <header>
            <h3>{{ selectedContextPack ? phaseLabel(selectedContextPack.phase) : 'Context Pack' }}</h3>
            <span v-if="selectedInvocation">{{ selectedInvocation.runtimeType }} / {{ selectedInvocation.status }}</span>
          </header>

          <div v-if="selectedContextPack" class="context-grid">
            <article>
              <h4>目标</h4>
              <p>{{ selectedContextPack.contextPack.sessionGoal }}</p>
            </article>
            <article>
              <h4>Agent</h4>
              <p>{{ selectedContextPack.contextPack.agentProfile?.name }} · {{ selectedContextPack.contextPack.agentProfile?.role }}</p>
            </article>
            <article>
              <h4>约束</h4>
              <ul>
                <li v-for="item in selectedContextPack.contextPack.constraints" :key="item">{{ item }}</li>
              </ul>
            </article>
            <article>
              <h4>能力</h4>
              <ul>
                <li v-for="item in selectedContextPack.contextPack.capabilities" :key="item.id">
                  {{ item.name }} <span>{{ item.riskLevel }}</span>
                </li>
              </ul>
            </article>
          </div>
        </section>

        <section class="debug-panel debug-split">
          <article>
            <header>
              <h3>Memory</h3>
              <span>{{ selectedContextPack?.contextPack.relevantMemories?.length ?? 0 }}</span>
            </header>
            <ul class="debug-list">
              <li v-for="memory in selectedContextPack?.contextPack.relevantMemories" :key="memory.id">
                <strong>{{ memory.scope }}</strong>
                <p>{{ memory.content }}</p>
                <small>confidence {{ percent(memory.confidence) }}</small>
              </li>
            </ul>
          </article>
          <article>
            <header>
              <h3>RAG</h3>
              <span>{{ selectedContextPack?.contextPack.ragSnippets?.length ?? 0 }}</span>
            </header>
            <ul class="debug-list">
              <li v-for="chunk in selectedContextPack?.contextPack.ragSnippets" :key="chunk.chunkId ?? chunk.title">
                <strong>{{ chunk.title }}</strong>
                <p>{{ chunk.snippet }}</p>
                <small>score {{ percent(chunk.score) }}</small>
              </li>
            </ul>
          </article>
        </section>

        <section class="debug-panel">
          <header>
            <h3>Token Usage</h3>
            <span>{{ tokenUsage.totalTokens }} total</span>
          </header>
          <div class="token-table">
            <div v-for="item in tokenUsage.byInvocation" :key="item.invocationId">
              <span>{{ phaseLabel(item.phase) }}</span>
              <strong>{{ item.agentKey }}</strong>
              <em>{{ item.usage?.totalTokens ?? 0 }}</em>
            </div>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>
