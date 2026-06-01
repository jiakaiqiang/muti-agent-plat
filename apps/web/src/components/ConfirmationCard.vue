<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  BriefEventPayload,
  ConfirmationCardState,
  ConfirmationOption,
  ConfirmationReason,
  ProposedFileWrite
} from '@/types/contracts'

const props = defineProps<{
  confirmation: ConfirmationCardState
  compact?: boolean
  currentBrief?: BriefEventPayload
}>()

const emit = defineEmits<{
  resolve: [optionKey: string]
  revise: [instruction: string]
}>()

// “修改简报”不是即时决议，而是让用户写下要改什么，再走后端重生成 + 二次确认的流程。
// 点击 revise 选项时进入内联编辑态，提交时把修改说明发给父组件。
const isRevising = ref(false)
const reviseText = ref('')

const reasonLabel = computed(() => confirmationReasonLabel(props.confirmation.reason))
const statusLabel = computed(() => confirmationStatusLabel(props.confirmation.status))

// 写入确认卡:展示每个待写入文件的 before/after,用户在写盘前实时查看改动内容。
const fileWrites = computed<ProposedFileWrite[]>(() => props.confirmation.writes ?? [])
const expandedPaths = ref<Set<string>>(new Set(fileWrites.value.map((write) => write.path)))

function toggleWrite(path: string) {
  const next = new Set(expandedPaths.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  expandedPaths.value = next
}

// 修改简报时把当前简报内容作为参考展示,避免编辑区“里面没有东西”。
const briefSections = computed(() => {
  const brief = props.currentBrief
  if (!brief) return []
  return [
    { label: '目标', items: brief.goal ? [brief.goal] : [] },
    { label: '范围', items: brief.scope ?? [] },
    { label: '验收标准', items: brief.acceptanceCriteria ?? [] },
    { label: '风险', items: brief.risks ?? [] }
  ].filter((section) => section.items.length > 0)
})

function onOptionClick(option: ConfirmationOption) {
  if (isReviseOption(option)) {
    isRevising.value = true
    return
  }
  emit('resolve', option.key)
}

function isReviseOption(option: ConfirmationOption) {
  return props.confirmation.reason === 'confirm_task_brief' && option.key === 'revise'
}

function submitRevision() {
  const instruction = reviseText.value.trim()
  if (!instruction) return
  emit('revise', instruction)
  reviseText.value = ''
  isRevising.value = false
}

function cancelRevision() {
  reviseText.value = ''
  isRevising.value = false
}

function confirmationReasonLabel(reason: ConfirmationReason) {
  return (
    {
      confirm_task_brief: '确认任务简报',
      approve_high_risk_capability: '审批高风险能力',
      resolve_contract_conflict: '解决契约冲突',
      continue_after_budget_warning: '预算预警后继续',
      send_feishu_notification: '发送飞书通知',
      apply_file_writes: '确认写入文件'
    }[reason] ?? reason
  )
}

function confirmationStatusLabel(status: ConfirmationCardState['status']) {
  return (
    {
      pending: '待确认',
      approved: '已确认',
      rejected: '已拒绝',
      expired: '已过期'
    }[status] ?? status
  )
}
</script>

<template>
  <section class="confirmation-card" :class="{ compact }">
    <div class="confirmation-card__heading">
      <span class="status-dot" :class="confirmation.status"></span>
      <div>
        <h3>{{ confirmation.title }}</h3>
        <p>{{ confirmation.description }}</p>
      </div>
    </div>

    <div class="confirmation-card__meta">
      <span>{{ reasonLabel }}</span>
      <span>{{ statusLabel }}</span>
    </div>

    <div v-if="fileWrites.length" class="confirmation-card__writes">
      <div v-for="write in fileWrites" :key="write.path" class="file-write">
        <button type="button" class="file-write__head" @click="toggleWrite(write.path)">
          <span class="file-write__path">{{ write.path }}</span>
          <span class="file-write__badge">{{ write.previousContent ? '修改' : '新建' }}</span>
        </button>
        <p v-if="write.summary" class="file-write__summary">{{ write.summary }}</p>
        <div v-if="expandedPaths.has(write.path)" class="file-write__diff">
          <div v-if="write.previousContent" class="file-write__pane">
            <h5>修改前</h5>
            <pre>{{ write.previousContent }}</pre>
          </div>
          <div class="file-write__pane">
            <h5>{{ write.previousContent ? '修改后' : '将写入' }}</h5>
            <pre>{{ write.content }}</pre>
          </div>
        </div>
      </div>
    </div>

    <div v-if="confirmation.status === 'pending' && isRevising" class="confirmation-card__revise">
      <div v-if="briefSections.length" class="confirmation-card__brief-ref">
        <h4>当前简报</h4>
        <dl>
          <div v-for="section in briefSections" :key="section.label">
            <dt>{{ section.label }}</dt>
            <dd>{{ section.items.join('、') }}</dd>
          </div>
        </dl>
      </div>
      <textarea
        v-model="reviseText"
        rows="3"
        placeholder="请描述要修改的内容（例如调整范围、补充约束或验收标准），提交后将重新生成简报并请你再次确认。"
      ></textarea>
      <div class="confirmation-card__actions">
        <button class="action-button default" type="button" @click="cancelRevision">取消</button>
        <button class="action-button primary" type="button" :disabled="!reviseText.trim()" @click="submitRevision">
          提交修改
        </button>
      </div>
    </div>

    <div v-else-if="confirmation.status === 'pending'" class="confirmation-card__actions">
      <button
        v-for="option in confirmation.options"
        :key="option.key"
        :class="['action-button', option.style ?? 'default']"
        type="button"
        @click="onOptionClick(option)"
      >
        {{ option.label }}
      </button>
    </div>
  </section>
</template>
