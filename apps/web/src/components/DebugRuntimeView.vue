<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiGet } from '@/api/client'
import type { CollaborationEvent } from '@/types/contracts'
import { runtimeTypeLabel } from '@/utils/runtimeLabels'
import UiIcon from './UiIcon.vue'

type DebugContextPack = {
  systemRules?: string[]
  sessionGoal?: string
  taskContext?: {
    domain?: 'coding' | 'non_coding' | 'mixed'
    intent?:
      | 'inquiry'
      | 'analysis'
      | 'implementation'
      | 'planning'
      | 'troubleshooting'
      | 'review'
      | 'validation'
      | 'delivery'
      | 'qa'
    currentStage?: string
    taskMap?: {
      kind?: 'project_map' | 'domain_map'
      summary?: string
      items?: Array<{
        type: string
        label: string
        ref?: string
        reason?: string
      }>
    }
    stagePlan?: {
      phase?: string
      read?: Array<{
        action: 'read'
        label: string
        refs?: string[]
        reason?: string
      }>
      do?: Array<{
        action: 'do'
        label: string
        refs?: string[]
        reason?: string
      }>
      validate?: Array<{
        action: 'validate'
        label: string
        refs?: string[]
        reason?: string
      }>
    }
    executionMode?: 'single_agent' | 'multi_agent'
    validationMode?: 'runtime_checks' | 'human_review' | 'mixed'
    requiresCodeChanges?: boolean
    requiresExternalEvidence?: boolean
    validationRules?: Array<{
      label: string
      evidenceRequired: string
    }>
    agentResponsibilities?: Array<{
      role: 'execution' | 'review' | 'validation'
      agentKey: string
      independentFrom?: string[]
    }>
    evidenceSelection?: {
      phase?: string
      strategy?: string
      query?: string
      maxEvidenceRefs?: number
      selectedCount?: number
      omittedCount?: number
      selectedTypes?: string[]
      omittedTypes?: string[]
      selectedRefs?: Array<{
        type: string
        label: string
        ref?: string
        estimatedTokens?: number
        selectionReason?: string
        omissionReason?: string
      }>
      omittedRefs?: Array<{
        type: string
        label: string
        ref?: string
        estimatedTokens?: number
        selectionReason?: string
        omissionReason?: string
      }>
      rules?: string[]
    }
    evidenceRefs?: Array<{
      type: string
      label: string
      ref?: string
      estimatedTokens?: number
      selectionReason?: string
      omissionReason?: string
    }>
  }
  projectMap?: {
    source?: string
    modules?: Array<{
      name: string
      path: string
      responsibility: string
      entrypoints?: string[]
      contracts?: string[]
      tests?: string[]
      commonTasks?: string[]
    }>
    validationCommands?: string[]
    riskBoundaries?: string[]
    memoryLocations?: string[]
    sourceRefs?: string[]
    generatedAt?: string
  }
  summaryMemory?: {
    goal?: string
    currentState?: string
    confirmedFacts?: string[]
    completed?: string[]
    decisions?: string[]
    openQuestions?: string[]
    risks?: string[]
    nextSteps?: string[]
  }
  continuationState?: {
    phase?: string
    sessionStatus?: string
    activeTaskId?: string
    activeAgentKey?: string
    lastCheckpointRef?: string
    pendingTaskIds?: string[]
    runningTaskIds?: string[]
    completedTaskIds?: string[]
    blockedTaskIds?: string[]
    nextAgentKeys?: string[]
    handoffRefs?: string[]
    sourceEventIds?: string[]
    sourceArtifactIds?: string[]
    resumeHints?: string[]
  }
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
  error?: {
    code?: string
    message?: string
    requestedContext?: {
      reason?: string
      requestedRefs?: Array<{
        type: string
        label: string
        ref?: string
      }>
      requestedPaths?: string[]
      requestedCommands?: string[]
      followUpInstruction?: string
    }
  }
  startedAt: string
  completedAt: string
  contextPackSummary: {
    sessionGoal: string
    agentKey: string
    taskDomain: string
    taskIntent: string
    currentStage: string
    taskMapKind: string
    taskMapItemCount: number
    stagePlanReadCount: number
    stagePlanDoCount: number
    stagePlanValidateCount: number
    executionMode: string
    validationMode: string
    validationRuleCount: number
    agentResponsibilityCount: number
    evidenceSelectionStrategy: string
    evidenceSelectionMaxRefs: number
    evidenceSelectionSelectedCount: number
    evidenceSelectionOmittedCount: number
    evidenceCount: number
    summaryConfirmedFactCount: number
    summaryCompletedCount: number
    summaryRiskCount: number
    continuationPhase: string
    continuationActiveTaskId?: string
    continuationPendingTaskCount: number
    continuationRunningTaskCount: number
    continuationCompletedTaskCount: number
    continuationBlockedTaskCount: number
    continuationResumeHintCount: number
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

function taskDomainLabel(domain?: string) {
  return (
    {
      coding: '编程任务',
      non_coding: '非编程任务',
      mixed: '混合任务'
    }[domain ?? ''] ?? domain ?? '-'
  )
}

function taskIntentLabel(intent?: string) {
  return (
    {
      analysis: '分析',
      implementation: '实现',
      planning: '规划',
      inquiry: '询问',
      troubleshooting: '排查',
      review: '评审',
      validation: '验证',
      delivery: '交付',
      qa: '问答'
    }[intent ?? ''] ?? intent ?? '-'
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
            <span v-if="selectedInvocation">
              {{ runtimeTypeLabel(selectedInvocation.runtimeType) }} / {{ selectedInvocation.usage?.model ?? '-' }} / {{ selectedInvocation.status }}
            </span>
          </header>

          <div v-if="selectedInvocation?.error?.requestedContext" class="context-warning">
            <strong>Needs more context</strong>
            <p>{{ selectedInvocation.error.requestedContext.reason ?? selectedInvocation.error.message }}</p>
            <small v-if="selectedInvocation.error.requestedContext.followUpInstruction">
              {{ selectedInvocation.error.requestedContext.followUpInstruction }}
            </small>
            <ul class="debug-list">
              <li
                v-for="ref in selectedInvocation.error.requestedContext.requestedRefs ?? []"
                :key="`requested-ref-${ref.type}-${ref.label}-${ref.ref ?? ''}`"
              >
                <strong>{{ ref.type }}</strong>
                <p>{{ ref.label }}</p>
                <small v-if="ref.ref">{{ ref.ref }}</small>
              </li>
              <li v-for="path in selectedInvocation.error.requestedContext.requestedPaths ?? []" :key="`requested-path-${path}`">
                <strong>path</strong>
                <p>{{ path }}</p>
              </li>
              <li v-for="command in selectedInvocation.error.requestedContext.requestedCommands ?? []" :key="`requested-command-${command}`">
                <strong>command</strong>
                <p>{{ command }}</p>
              </li>
            </ul>
          </div>

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
              <h4>任务类型</h4>
              <p>
                {{ taskDomainLabel(selectedContextPack.contextPack.taskContext?.domain) }}
                ·
                {{ taskIntentLabel(selectedContextPack.contextPack.taskContext?.intent) }}
              </p>
            </article>
            <article>
              <h4>执行模式</h4>
              <p>
                {{ selectedContextPack.contextPack.taskContext?.executionMode ?? '-' }}
                ·
                {{ selectedContextPack.contextPack.taskContext?.validationMode ?? '-' }}
              </p>
            </article>
            <article>
              <h4>任务地图</h4>
              <p>
                {{ selectedContextPack.contextPack.taskContext?.taskMap?.kind ?? '-' }}
                ·
                {{ selectedContextPack.contextPack.taskContext?.currentStage ?? '-' }}
              </p>
              <small>{{ selectedContextPack.contextPack.taskContext?.taskMap?.summary }}</small>
              <ul class="debug-list">
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.taskMap?.items ?? []"
                  :key="`${item.type}-${item.label}-${item.ref ?? ''}`"
                >
                  <strong>{{ item.type }}</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.reason">{{ item.reason }}</small>
                </li>
              </ul>
            </article>
            <article>
              <h4>Project Map</h4>
              <p>
                {{ selectedContextPack.contextPack.projectMap?.source ?? '-' }}
                ·
                {{ selectedContextPack.contextPack.projectMap?.modules?.length ?? 0 }} modules
              </p>
              <small v-if="selectedContextPack.contextPack.projectMap?.sourceRefs?.length">
                refs: {{ selectedContextPack.contextPack.projectMap.sourceRefs.join(', ') }}
              </small>
              <ul class="debug-list">
                <li
                  v-for="module in selectedContextPack.contextPack.projectMap?.modules ?? []"
                  :key="`project-module-${module.path}`"
                >
                  <strong>{{ module.name }}</strong>
                  <p>{{ module.responsibility }}</p>
                  <small v-if="module.entrypoints?.length">entrypoints: {{ module.entrypoints.join(', ') }}</small>
                  <small v-if="module.contracts?.length">contracts: {{ module.contracts.join(', ') }}</small>
                  <small v-if="module.tests?.length">tests: {{ module.tests.join(', ') }}</small>
                </li>
                <li v-for="command in selectedContextPack.contextPack.projectMap?.validationCommands ?? []" :key="`project-validation-${command}`">
                  <strong>validation</strong>
                  <p>{{ command }}</p>
                </li>
                <li v-for="boundary in selectedContextPack.contextPack.projectMap?.riskBoundaries ?? []" :key="`project-boundary-${boundary}`">
                  <strong>boundary</strong>
                  <p>{{ boundary }}</p>
                </li>
              </ul>
            </article>
            <article>
              <h4>Stage Plan</h4>
              <p>{{ selectedContextPack.contextPack.taskContext?.stagePlan?.phase ?? selectedContextPack.contextPack.taskContext?.currentStage ?? '-' }}</p>
              <ul class="debug-list">
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.stagePlan?.read ?? []"
                  :key="`read-${item.label}-${item.refs?.join('|') ?? ''}`"
                >
                  <strong>read</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.refs?.length">{{ item.refs.join(', ') }}</small>
                  <small v-if="item.reason">{{ item.reason }}</small>
                </li>
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.stagePlan?.do ?? []"
                  :key="`do-${item.label}-${item.refs?.join('|') ?? ''}`"
                >
                  <strong>do</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.refs?.length">{{ item.refs.join(', ') }}</small>
                  <small v-if="item.reason">{{ item.reason }}</small>
                </li>
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.stagePlan?.validate ?? []"
                  :key="`validate-${item.label}-${item.refs?.join('|') ?? ''}`"
                >
                  <strong>validate</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.refs?.length">{{ item.refs.join(', ') }}</small>
                  <small v-if="item.reason">{{ item.reason }}</small>
                </li>
              </ul>
            </article>
            <article>
              <h4>Continuation</h4>
              <p>
                {{ selectedContextPack.contextPack.continuationState?.phase ?? '-' }}
                /
                {{ selectedContextPack.contextPack.continuationState?.sessionStatus ?? '-' }}
              </p>
              <ul class="debug-list">
                <li v-if="selectedContextPack.contextPack.continuationState?.activeTaskId">
                  <strong>active task</strong>
                  <p>{{ selectedContextPack.contextPack.continuationState.activeTaskId }}</p>
                  <small>{{ selectedContextPack.contextPack.continuationState.activeAgentKey ?? '-' }}</small>
                </li>
                <li v-if="selectedContextPack.contextPack.continuationState?.lastCheckpointRef">
                  <strong>checkpoint</strong>
                  <p>{{ selectedContextPack.contextPack.continuationState.lastCheckpointRef }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.continuationState?.resumeHints ?? []" :key="`resume-${item}`">
                  <strong>resume</strong>
                  <p>{{ item }}</p>
                </li>
                <li v-if="selectedContextPack.contextPack.continuationState?.nextAgentKeys?.length">
                  <strong>next agents</strong>
                  <p>{{ selectedContextPack.contextPack.continuationState.nextAgentKeys.join(', ') }}</p>
                </li>
              </ul>
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
            <article>
              <h4>Evidence Selection</h4>
              <p>
                {{ selectedContextPack.contextPack.taskContext?.evidenceSelection?.strategy ?? '-' }}
                /
                {{ selectedContextPack.contextPack.taskContext?.evidenceSelection?.selectedCount ?? 0 }}
                of
                {{ selectedContextPack.contextPack.taskContext?.evidenceSelection?.maxEvidenceRefs ?? 0 }}
              </p>
              <small v-if="selectedContextPack.contextPack.taskContext?.evidenceSelection?.omittedCount">
                omitted {{ selectedContextPack.contextPack.taskContext.evidenceSelection.omittedCount }}
              </small>
              <ul class="debug-list">
                <li v-if="selectedContextPack.contextPack.taskContext?.evidenceSelection?.query">
                  <strong>query</strong>
                  <p>{{ selectedContextPack.contextPack.taskContext.evidenceSelection.query }}</p>
                </li>
                <li v-for="rule in selectedContextPack.contextPack.taskContext?.evidenceSelection?.rules ?? []" :key="`evidence-rule-${rule}`">
                  <strong>rule</strong>
                  <p>{{ rule }}</p>
                </li>
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.evidenceSelection?.selectedRefs ?? []"
                  :key="`selected-${item.type}-${item.label}-${item.ref ?? ''}`"
                >
                  <strong>selected {{ item.type }}</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.ref">{{ item.ref }}</small>
                  <small v-if="item.estimatedTokens">tokens: {{ item.estimatedTokens }}</small>
                  <small v-if="item.selectionReason">{{ item.selectionReason }}</small>
                </li>
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.evidenceSelection?.omittedRefs ?? []"
                  :key="`omitted-${item.type}-${item.label}-${item.ref ?? ''}`"
                >
                  <strong>omitted {{ item.type }}</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.ref">{{ item.ref }}</small>
                  <small v-if="item.estimatedTokens">tokens: {{ item.estimatedTokens }}</small>
                  <small v-if="item.omissionReason">{{ item.omissionReason }}</small>
                </li>
              </ul>
            </article>
            <article>
              <h4>证据来源</h4>
              <ul class="debug-list">
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.evidenceRefs ?? []"
                  :key="`${item.type}-${item.label}-${item.ref ?? ''}`"
                >
                  <strong>{{ item.type }}</strong>
                  <p>{{ item.label }}</p>
                  <small v-if="item.ref">{{ item.ref }}</small>
                  <small v-if="item.estimatedTokens">tokens: {{ item.estimatedTokens }}</small>
                  <small v-if="item.selectionReason">{{ item.selectionReason }}</small>
                </li>
              </ul>
            </article>
            <article>
              <h4>验证与分工</h4>
              <ul class="debug-list">
                <li
                  v-for="rule in selectedContextPack.contextPack.taskContext?.validationRules ?? []"
                  :key="`rule-${rule.label}`"
                >
                  <strong>{{ rule.label }}</strong>
                  <p>{{ rule.evidenceRequired }}</p>
                </li>
                <li
                  v-for="item in selectedContextPack.contextPack.taskContext?.agentResponsibilities ?? []"
                  :key="`role-${item.role}-${item.agentKey}`"
                >
                  <strong>{{ item.role }}</strong>
                  <p>{{ item.agentKey }}</p>
                  <small v-if="item.independentFrom?.length">independent from {{ item.independentFrom.join(', ') }}</small>
                </li>
              </ul>
            </article>
            <article>
              <h4>阶段摘要</h4>
              <ul class="debug-list">
                <li v-if="selectedContextPack.contextPack.summaryMemory?.currentState">
                  <strong>当前状态</strong>
                  <p>{{ selectedContextPack.contextPack.summaryMemory.currentState }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.summaryMemory?.confirmedFacts ?? []" :key="`fact-${item}`">
                  <strong>已确认事实</strong>
                  <p>{{ item }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.summaryMemory?.completed ?? []" :key="`done-${item}`">
                  <strong>已完成</strong>
                  <p>{{ item }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.summaryMemory?.decisions ?? []" :key="`decision-${item}`">
                  <strong>决策</strong>
                  <p>{{ item }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.summaryMemory?.nextSteps ?? []" :key="`next-${item}`">
                  <strong>下一步</strong>
                  <p>{{ item }}</p>
                </li>
                <li v-for="item in selectedContextPack.contextPack.summaryMemory?.risks ?? []" :key="`risk-${item}`">
                  <strong>风险</strong>
                  <p>{{ item }}</p>
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
              <small>{{ item.usage?.model ?? '-' }}</small>
              <em>{{ item.usage?.totalTokens ?? 0 }}</em>
            </div>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>
