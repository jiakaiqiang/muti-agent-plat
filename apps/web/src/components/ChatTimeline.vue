<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import type {
  ArtifactEventPayload,
  BriefEventPayload,
  ChatMessage,
  ConfirmationCardState,
  ConfirmationRequestedPayload,
  FinalDeliveryPayload,
  ToolEventPayload
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'

const props = defineProps<{
  messages: ChatMessage[]
  currentBrief?: BriefEventPayload
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
  reviseBrief: [instruction: string]
}>()

const agentStore = useAgentStore()
const timeline = computed(() => props.messages)

const timelineRef = ref<HTMLElement | null>(null)
// 用户主动向上翻看历史时不强行拉回底部;贴近底部才视为“跟随最新”。
const stickToBottom = ref(true)
const NEAR_BOTTOM_THRESHOLD = 80

function isNearBottom() {
  const el = timelineRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD
}

function onScroll() {
  stickToBottom.value = isNearBottom()
}

function scrollToBottom() {
  const el = timelineRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

onMounted(() => {
  void nextTick(scrollToBottom)
})

watch(
  () => {
    const last = timeline.value[timeline.value.length - 1]
    return `${timeline.value.length}:${last?.id ?? ''}:${last?.content?.length ?? 0}`
  },
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    scrollToBottom()
  }
)

function senderLabel(message: ChatMessage) {
  if (message.senderType === 'user') return '你'
  if (message.senderType === 'agent') return agentStore.agentName(message.senderAgentId)
  return '系统'
}

function agentTone(message: ChatMessage) {
  const index = agentStore.agents.findIndex((agent) => agent.id === message.senderAgentId)
  if (message.senderType === 'system') return 'system'
  if (message.senderType === 'user') return 'user'
  return ((index < 0 ? 0 : index) % 5) + 1
}

function confirmationFromMessage(message: ChatMessage): ConfirmationCardState | undefined {
  if (message.messageType !== 'confirmation') return undefined
  const payload = message.payload as (ConfirmationRequestedPayload & Record<string, unknown>) | undefined
  if (!payload) return undefined
  return {
    confirmationId: payload.confirmationId,
    reason: payload.reason,
    title: payload.title,
    description: payload.description,
    status: (payload.status as ConfirmationCardState['status'] | undefined) ?? 'pending',
    options: payload.options,
    relatedBriefId: payload.relatedBriefId as string | undefined,
    relatedTaskId: (payload.relatedTaskId ?? payload.taskId) as string | undefined,
    relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
    relatedArtifactId: payload.relatedArtifactId as string | undefined,
    taskTitle: payload.taskTitle as string | undefined,
    writes: payload.writes
  }
}

function listFromPayload(message: ChatMessage, key: string) {
  const value = message.payload?.[key]
  return Array.isArray(value) ? value : []
}

function toolPayload(message: ChatMessage) {
  if (message.messageType !== 'tool') return undefined
  const payload = message.payload as ToolEventPayload | undefined
  return payload?.capabilityId || payload?.capabilityName ? payload : undefined
}

function artifactPayload(message: ChatMessage) {
  return message.messageType === 'artifact' ? (message.payload as ArtifactEventPayload | undefined) : undefined
}

function deliveryPayload(message: ChatMessage) {
  return message.messageType === 'delivery' ? (message.payload as FinalDeliveryPayload | undefined) : undefined
}

function statusLabel(status?: string) {
  return (
    {
      allowed: '已允许',
      approved: '已批准',
      blocked: '已阻止',
      completed: '已完成',
      failed: '失败',
      pending: '待处理',
      running: '执行中'
    }[status ?? ''] ?? status ?? '未知'
  )
}

function capabilityLabel(capabilityId?: string) {
  return capabilityId ? agentStore.capabilityName(capabilityId) : undefined
}
</script>

<template>
  <main ref="timelineRef" class="chat-timeline" @scroll="onScroll">
    <article
      v-for="message in timeline"
      :key="message.id"
      class="timeline-item"
      :class="[message.senderType, message.messageType]"
    >
      <AgentPortrait :tone="agentTone(message)" :label="senderLabel(message)" size="md" />
      <div class="message-bubble">
        <header class="message-header">
          <strong>{{ senderLabel(message) }}</strong>
          <span>{{ new Date(message.createdAt).toLocaleTimeString() }}</span>
        </header>

        <ConfirmationCard
          v-if="confirmationFromMessage(message)"
          :confirmation="confirmationFromMessage(message)!"
          :current-brief="props.currentBrief"
          compact
          @resolve="emit('resolveConfirmation', $event)"
          @revise="emit('reviseBrief', $event)"
        />

        <template v-else>
          <p class="message-content">{{ message.content }}</p>

          <div v-if="message.messageType === 'brief'" class="structured-block">
            <h3>{{ message.payload?.goal }}</h3>
            <dl>
              <div>
                <dt>范围</dt>
                <dd>{{ listFromPayload(message, 'scope').join(', ') }}</dd>
              </div>
              <div>
                <dt>验收标准</dt>
                <dd>{{ listFromPayload(message, 'acceptanceCriteria').join(', ') }}</dd>
              </div>
              <div>
                <dt>风险</dt>
                <dd>{{ listFromPayload(message, 'risks').join(', ') }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="message.messageType === 'delivery'" class="structured-block">
            <h3>{{ message.payload?.summary }}</h3>
            <div v-if="deliveryPayload(message)?.notificationDraftArtifactId" class="inline-metadata">
              <span>飞书草稿</span>
              <strong>{{ deliveryPayload(message)?.notificationDraftArtifactId }}</strong>
            </div>
            <ul>
              <li v-for="item in listFromPayload(message, 'completedItems')" :key="String(item)">{{ item }}</li>
            </ul>
          </div>

          <div v-if="toolPayload(message)" class="structured-block tool-block">
            <div class="structured-block__heading">
              <h3>{{ toolPayload(message)?.capabilityName ?? '能力' }}</h3>
              <span class="status-pill" :class="toolPayload(message)?.status">
                {{ statusLabel(toolPayload(message)?.status) }}
              </span>
            </div>
            <dl>
              <div>
                <dt>风险等级</dt>
                <dd>{{ toolPayload(message)?.riskLevel ?? '未知' }}</dd>
              </div>
              <div v-if="toolPayload(message)?.requiresUserConfirmation">
                <dt>策略</dt>
                <dd>需要用户确认</dd>
              </div>
              <div v-if="toolPayload(message)?.reason">
                <dt>原因</dt>
                <dd>{{ toolPayload(message)?.reason }}</dd>
              </div>
              <div v-if="toolPayload(message)?.code">
                <dt>代码</dt>
                <dd>{{ toolPayload(message)?.code }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="artifactPayload(message)" class="structured-block artifact-block">
            <div class="structured-block__heading">
              <h3>{{ artifactPayload(message)?.title }}</h3>
              <span class="status-pill" :class="artifactPayload(message)?.type">{{ artifactPayload(message)?.type }}</span>
            </div>
            <p v-if="artifactPayload(message)?.contentSummary">{{ artifactPayload(message)?.contentSummary }}</p>
            <p v-if="artifactPayload(message)?.relatedCapabilityId">
              能力：{{ capabilityLabel(artifactPayload(message)?.relatedCapabilityId) }}
            </p>
          </div>

          <div v-if="message.messageType === 'rag'" class="structured-block">
            <h3>{{ message.payload?.query }}</h3>
            <p
              v-for="chunk in (message.payload?.matchedChunks as Array<Record<string, unknown>> | undefined) ?? []"
              :key="String(chunk.chunkId)"
            >
              {{ chunk.title }}: {{ chunk.snippet }}
            </p>
          </div>
        </template>
      </div>
    </article>
  </main>
</template>
