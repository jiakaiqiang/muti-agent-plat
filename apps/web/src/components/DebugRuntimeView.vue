<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useDebugStore } from '@/stores/debug'
import type { CollaborationEvent } from '@/types/contracts'
import { runtimeTypeLabel } from '@/utils/runtimeLabels'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  sessionId: string
  events: CollaborationEvent[]
}>()

const debugStore = useDebugStore()
const { loading, error, invocations, tokenUsage } = storeToRefs(debugStore)
const selectedInvocation = computed(() => debugStore.selectedInvocation)
const allowedToolCount = computed(
  () => selectedInvocation.value?.toolCatalog.decisions.filter((decision) => decision.status === 'allowed').length ?? 0
)
const blockedToolCount = computed(
  () => selectedInvocation.value?.toolCatalog.decisions.filter((decision) => decision.status === 'blocked').length ?? 0
)
const runtimeEventCount = computed(() => props.events.filter((event) => event.type.startsWith('runtime_')).length)
const latestUpdatedAt = computed(() => {
  const value = invocations.value.map((item) => item.completedAt || item.startedAt).filter(Boolean).sort().at(-1)
  return value ? new Date(value).toLocaleTimeString() : '未同步'
})

async function loadDebugData() {
  await debugStore.loadDebugData(props.sessionId)
}

function phaseLabel(phase: string) {
  return (
    {
      brief_generation: '契约生成',
      discussion: '讨论',
      task_execution: '任务执行',
      post_review: '复盘',
      final_delivery: '最终交付',
      user_message_routing: '消息路由'
    }[phase] ?? phase
  )
}

watch(() => props.sessionId, loadDebugData, { immediate: true })
</script>

<template>
  <section class="debug-view">
    <header class="debug-topbar">
      <div>
        <h2>调用审计台</h2>
        <p>按调用核对 Agent 身份、工具授权、执行目标与 ContextEnvelope v2。</p>
      </div>
      <div class="debug-actions">
        <span>{{ latestUpdatedAt }}</span>
        <button type="button" :disabled="loading || !sessionId" title="刷新审计数据" @click="loadDebugData">
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
        <span>允许工具</span>
        <strong>{{ allowedToolCount }}</strong>
        <small>{{ blockedToolCount }} 个阻止决策</small>
      </article>
      <article>
        <span>证据文件</span>
        <strong>{{ selectedInvocation?.summary.evidenceCount ?? 0 }}</strong>
        <small>{{ selectedInvocation?.summary.evidenceBytes ?? 0 }} bytes</small>
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
          v-for="item in invocations"
          :key="item.invocationId"
          type="button"
          :class="{ active: item.invocationId === selectedInvocation?.invocationId }"
          @click="debugStore.selectInvocation(item.invocationId)"
        >
          <span>{{ phaseLabel(item.phase) }}</span>
          <strong>{{ item.agentKey }}</strong>
          <small>{{ item.status }} · {{ item.invocationId }}</small>
        </button>
        <p v-if="!invocations.length">暂无 Runtime 调用</p>
      </aside>

      <main v-if="selectedInvocation" class="debug-detail">
        <section class="debug-panel">
          <header>
            <h3>{{ phaseLabel(selectedInvocation.phase) }}</h3>
            <span>{{ selectedInvocation.invocationId }} · {{ selectedInvocation.status }}</span>
          </header>
          <div class="context-grid">
            <article>
              <h4>Agent Identity</h4>
              <p>{{ selectedInvocation.agentKey }} · revision {{ selectedInvocation.identity.profileRevision }}</p>
              <small>profileHash: {{ selectedInvocation.identity.profileHash }}</small>
            </article>
            <article>
              <h4>Skill snapshots</h4>
              <ul class="debug-list">
                <li v-for="skillId in selectedInvocation.identity.resolvedSkillIds" :key="skillId">
                  <strong>{{ skillId }}</strong>
                  <small>revision {{ selectedInvocation.identity.resolvedSkillRevisions[skillId] }}</small>
                </li>
                <li v-if="!selectedInvocation.identity.resolvedSkillIds.length">未引用 Skill</li>
              </ul>
            </article>
            <article>
              <h4>Execution Target</h4>
              <p>
                {{ runtimeTypeLabel(selectedInvocation.executionTarget.runtimeType) }}
                <span v-if="selectedInvocation.executionTarget.modelId"> · {{ selectedInvocation.executionTarget.modelId }}</span>
              </p>
              <small>{{ selectedInvocation.executionTarget.source }} · {{ selectedInvocation.executionTarget.reason }}</small>
            </article>
            <article v-if="selectedInvocation.attempt">
              <h4>Attempt Trace</h4>
              <p>第 {{ selectedInvocation.attempt.attempt }} 次 · {{ selectedInvocation.attempt.attemptGroupId }}</p>
              <small v-if="selectedInvocation.attempt.fallbackFromRuntimeType">
                fallback from {{ runtimeTypeLabel(selectedInvocation.attempt.fallbackFromRuntimeType) }} · {{ selectedInvocation.attempt.fallbackReason }}
              </small>
              <small v-else-if="selectedInvocation.attempt.retryOfInvocationId">
                retry of {{ selectedInvocation.attempt.retryOfInvocationId }}
              </small>
            </article>
          </div>
        </section>

        <section class="debug-panel">
          <header>
            <h3>Tool Authority</h3>
            <span>catalogHash: {{ selectedInvocation.toolCatalog.catalogHash }}</span>
          </header>
          <div class="token-table">
            <div v-for="decision in selectedInvocation.toolCatalog.decisions" :key="decision.toolId">
              <span>{{ decision.status }}</span>
              <strong>{{ decision.toolKey }}</strong>
              <small>{{ decision.reasons.join(' · ') }}</small>
              <em>{{ decision.toolId }}</em>
            </div>
          </div>
        </section>

        <section class="debug-panel">
          <header>
            <h3>ContextEnvelope v2</h3>
            <span>{{ selectedInvocation.contextEnvelope.workspaceId }} · {{ selectedInvocation.contextEnvelope.createdAt }}</span>
          </header>
          <div class="context-grid">
            <article>
              <h4>L0 Authority</h4>
              <p>Profile r{{ selectedInvocation.contextEnvelope.L0.profileRevision }}</p>
              <small>{{ selectedInvocation.contextEnvelope.L0.toolCatalogHash }}</small>
            </article>
            <article>
              <h4>L1 Invocation</h4>
              <p>{{ selectedInvocation.contextEnvelope.L1.sessionGoal }}</p>
              <small>{{ selectedInvocation.contextEnvelope.L1.navigation.entries.length }} navigation entries</small>
            </article>
            <article>
              <h4>L2 Project Map</h4>
              <p>{{ selectedInvocation.contextEnvelope.L2.source }}</p>
              <small>{{ selectedInvocation.contextEnvelope.L2.modules.length }} modules</small>
            </article>
            <article>
              <h4>L3 Evidence</h4>
              <p>{{ selectedInvocation.contextEnvelope.L3.files.length }} files</p>
              <small>{{ selectedInvocation.contextEnvelope.L3.totalByteLength }} bytes</small>
            </article>
            <article>
              <h4>L4 Tool Results</h4>
              <p>{{ selectedInvocation.contextEnvelope.L4.calls.length }} calls</p>
            </article>
            <article>
              <h4>L5 Summary Memory</h4>
              <p>{{ selectedInvocation.contextEnvelope.L5.bullets.length }} bullets</p>
              <small>{{ selectedInvocation.contextEnvelope.L5.turnCount }} turns</small>
            </article>
            <article>
              <h4>L6 Delivery</h4>
              <p>{{ selectedInvocation.contextEnvelope.L6.changeSetIds.length }} change sets</p>
              <small>{{ selectedInvocation.contextEnvelope.L6.reportIds.length }} reports</small>
            </article>
          </div>
        </section>

        <section class="debug-panel">
          <header>
            <h3>Output Contract</h3>
            <span>{{ selectedInvocation.outputContract.contractVersion }} · {{ selectedInvocation.expectedOutput.kind }}</span>
          </header>
          <div class="context-grid">
            <article>
              <h4>Contract</h4>
              <p>{{ selectedInvocation.outputContract.contractId }}</p>
              <small>{{ selectedInvocation.outputContract.schemaHash }}</small>
            </article>
            <article>
              <h4>Data Epoch</h4>
              <p>{{ selectedInvocation.dataEpoch }}</p>
              <small>schema {{ selectedInvocation.expectedOutput.schemaVersion }}</small>
            </article>
            <article>
              <h4>System Evidence</h4>
              <p>{{ selectedInvocation.systemEvidence.workspaceChangeSet?.changes.length ?? 0 }} changes</p>
              <small>{{ selectedInvocation.systemEvidence.verifiedTestResults.length }} verified tests</small>
            </article>
          </div>
        </section>

        <section v-if="selectedInvocation.runtimeDiagnostics" class="debug-panel">
          <header>
            <h3>Runtime Diagnostics</h3>
            <span>{{ selectedInvocation.runtimeDiagnostics.unknownNotificationCount }} unknown</span>
          </header>
          <div class="token-table">
            <div
              v-for="notification in selectedInvocation.runtimeDiagnostics.providerNotifications"
              :key="`${notification.method}:${notification.disposition}`"
            >
              <span>{{ notification.disposition }}</span>
              <strong>{{ notification.method }}</strong>
            </div>
          </div>
          <pre v-if="selectedInvocation.runtimeDiagnostics.stderrTail">{{ selectedInvocation.runtimeDiagnostics.stderrTail }}</pre>
        </section>

        <section v-if="selectedInvocation.error" class="debug-panel">
          <header>
            <h3>Runtime Error</h3>
            <span>{{ selectedInvocation.error.code }}</span>
          </header>
          <p>{{ selectedInvocation.error.message }}</p>
          <small v-if="selectedInvocation.termination">
            {{ selectedInvocation.termination.kind }} · {{ selectedInvocation.termination.source }} ·
            {{ selectedInvocation.termination.scope }}
          </small>
          <small v-if="selectedInvocation.error.requestedContext">
            {{ selectedInvocation.error.requestedContext.reason }}
          </small>
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
