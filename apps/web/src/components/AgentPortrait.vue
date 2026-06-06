<script setup lang="ts">
import UiIcon from './UiIcon.vue'

withDefaults(
  defineProps<{
    tone?: number | 'system' | 'user'
    label?: string
    size?: 'sm' | 'md' | 'lg'
    badgeIcon?: string
  }>(),
  {
    tone: 1,
    label: '',
    size: 'md',
    badgeIcon: 'bot'
  }
)
</script>

<template>
  <span
    :class="['agent-portrait', `agent-tone-${tone}`, `agent-portrait--${size}`]"
    :title="label"
  >
    <span class="agent-portrait__halo" aria-hidden="true"></span>
    <span class="agent-portrait__face" aria-hidden="true">
      <span class="agent-portrait__hair"></span>
      <span class="agent-portrait__eyes"></span>
      <span class="agent-portrait__smile"></span>
    </span>
    <span class="agent-portrait__badge">
      <UiIcon :name="badgeIcon" :size="size === 'sm' ? 11 : 13" :stroke-width="2.5" />
    </span>
  </span>
</template>
