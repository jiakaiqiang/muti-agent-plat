<script setup lang="ts">
import type { ConfirmationCardState, PostReviewAction } from '@/types/contracts'

defineProps<{
  confirmation: ConfirmationCardState
  compact?: boolean
}>()

const emit = defineEmits<{
  resolve: [optionKey: string]
}>()

function actionLabel(action: PostReviewAction) {
  return {
    request_workspace_context: '补读工作区',
    deliver_with_limitations: '受限交付',
    save_progress: '保存当前进度',
    cancel: '取消任务'
  }[action.action]
}

function actionStyle(action: PostReviewAction) {
  if (action.action === 'request_workspace_context') return 'primary'
  if (action.action === 'cancel') return 'danger'
  return 'default'
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
      <span>{{ confirmation.reason }}</span>
      <span>{{ confirmation.status }}</span>
    </div>

    <div
      v-if="confirmation.status === 'pending' && confirmation.actions?.length"
      class="confirmation-card__structured-actions"
    >
      <div
        v-for="(action, index) in confirmation.actions"
        :key="`${action.action}-${index}`"
        class="confirmation-card__structured-action"
      >
        <div class="confirmation-card__action-copy">
          <strong>{{ actionLabel(action) }}</strong>
          <p v-if="action.action === 'request_workspace_context'">{{ action.reason }}</p>
          <p v-else-if="action.action === 'cancel' && action.reason">{{ action.reason }}</p>
          <ul v-if="action.action === 'request_workspace_context'">
            <li v-for="path in action.missingPaths" :key="path">{{ path }}</li>
          </ul>
          <ul v-else-if="action.action === 'deliver_with_limitations'">
            <li v-for="limitation in action.limitations" :key="limitation">{{ limitation }}</li>
          </ul>
        </div>
        <button
          :data-action="action.action"
          :class="['action-button', actionStyle(action)]"
          type="button"
          @click="emit('resolve', action.action)"
        >
          {{ actionLabel(action) }}
        </button>
      </div>
    </div>

    <div v-else-if="confirmation.status === 'pending'" class="confirmation-card__actions">
      <button
        v-for="option in confirmation.options"
        :key="option.key"
        :class="['action-button', option.style ?? 'default']"
        type="button"
        @click="emit('resolve', option.key)"
      >
        {{ option.label }}
      </button>
    </div>
  </section>
</template>
