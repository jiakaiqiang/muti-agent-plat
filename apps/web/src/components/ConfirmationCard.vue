<script setup lang="ts">
import type { ConfirmationCardState } from '@/types/contracts'

defineProps<{
  confirmation: ConfirmationCardState
  compact?: boolean
}>()

const emit = defineEmits<{
  resolve: [optionKey: string]
}>()
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

    <div v-if="confirmation.status === 'pending'" class="confirmation-card__actions">
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
