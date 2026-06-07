<script setup lang="ts">
import type { SessionListItem } from '@/types/contracts'
import { sessionStatusLabel } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

defineProps<{
  sessions: SessionListItem[]
  currentSessionId?: string
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  delete: [sessionId: string]
}>()
</script>

<template>
  <aside class="session-sidebar">
    <header class="session-sidebar__header">
      <button class="new-session-button" type="button" @click="emit('create')">
        <UiIcon name="plus" :size="19" :stroke-width="2.6" />
        新建会话
      </button>
      <button class="icon-button" type="button" title="更多">
        <UiIcon name="more" :size="19" />
      </button>
    </header>

    <label class="session-search">
      <UiIcon name="search" :size="18" />
      <input type="search" placeholder="搜索会话" />
      <button class="session-filter-button" type="button" title="筛选">
        <UiIcon name="filter" :size="17" />
      </button>
    </label>

    <div class="session-tabs">
      <button type="button" class="active">全部</button>
      <button type="button">我创建的</button>
      <button type="button">收藏</button>
    </div>

    <article
      v-for="(session, index) in sessions"
      :key="session.id"
      class="session-list-item"
      :class="{ active: session.id === currentSessionId }"
      @click="emit('select', session.id)"
    >
      <AgentPortrait :tone="(index % 5) + 1" :label="session.title" size="md" />
      <span class="session-item-main">
        <span class="session-title">{{ session.title }}</span>
        <span v-if="session.latestEventSummary" class="session-summary">{{ session.latestEventSummary }}</span>
        <span class="session-budget">群聊 · {{ session.agentCount }} Agents</span>
      </span>
      <span class="session-meta">
        <span>{{ sessionStatusLabel[session.status] }}</span>
        <span>{{ session.tokenUsed }} / {{ session.tokenBudget ?? '∞' }}</span>
      </span>
      <button class="session-delete-button" type="button" title="删除会话" @click.stop="emit('delete', session.id)">
        <UiIcon name="trash" :size="16" />
      </button>
    </article>
  </aside>
</template>
