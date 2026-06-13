<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SessionListItem } from '@/types/contracts'
import { sessionStatusLabel } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

type SessionTab = 'all' | 'mine' | 'favorites'

const props = defineProps<{
  sessions: SessionListItem[]
  currentSessionId?: string
  favoriteSessionIds: string[]
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  delete: [sessionId: string]
  toggleFavorite: [sessionId: string]
}>()

const activeTab = ref<SessionTab>('all')
const search = ref('')
const contextMenu = ref<{ sessionId: string; x: number; y: number } | undefined>()

const favoriteIds = computed(() => new Set(props.favoriteSessionIds))

const filteredSessions = computed(() => {
  const query = search.value.trim().toLowerCase()
  return props.sessions.filter((session) => {
    if (activeTab.value === 'favorites' && !favoriteIds.value.has(session.id)) return false
    if (query && !`${session.title} ${session.latestEventSummary ?? ''}`.toLowerCase().includes(query)) return false
    return true
  })
})

function openContextMenu(event: MouseEvent, sessionId: string) {
  event.preventDefault()
  contextMenu.value = {
    sessionId,
    x: event.clientX,
    y: Math.max(12, event.clientY - 12)
  }
}

function closeContextMenu() {
  contextMenu.value = undefined
}

function toggleFavorite(sessionId: string) {
  emit('toggleFavorite', sessionId)
  closeContextMenu()
}

function deleteSession(sessionId: string) {
  emit('delete', sessionId)
  closeContextMenu()
}

function isFavorite(sessionId: string) {
  return favoriteIds.value.has(sessionId)
}

function handleGlobalPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('.session-context-menu')) return
  closeContextMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown)
})
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
      <input v-model="search" type="search" placeholder="搜索会话" />
      <button class="session-filter-button" type="button" title="筛选">
        <UiIcon name="filter" :size="17" />
      </button>
    </label>

    <div class="session-tabs">
      <button type="button" :class="{ active: activeTab === 'all' }" @click="activeTab = 'all'">全部</button>
      <button type="button" :class="{ active: activeTab === 'mine' }" @click="activeTab = 'mine'">我创建的</button>
      <button type="button" :class="{ active: activeTab === 'favorites' }" @click="activeTab = 'favorites'">收藏</button>
    </div>

    <article
      v-for="(session, index) in filteredSessions"
      :key="session.id"
      class="session-list-item"
      :class="{ active: session.id === currentSessionId, favorite: isFavorite(session.id) }"
      @click="emit('select', session.id)"
      @contextmenu="openContextMenu($event, session.id)"
    >
      <AgentPortrait :tone="(index % 5) + 1" :label="session.title" size="md" />
      <span class="session-item-main">
        <span class="session-title">
          <span>{{ session.title }}</span>
          <UiIcon v-if="isFavorite(session.id)" name="sparkles" :size="13" />
        </span>
        <span v-if="session.latestEventSummary" class="session-summary">{{ session.latestEventSummary }}</span>
        <span class="session-budget">群聊 / {{ session.agentCount }} Agents</span>
      </span>
      <span class="session-meta">
        <span>{{ sessionStatusLabel[session.status] }}</span>
        <span>{{ session.tokenUsed }} / {{ session.tokenBudget ?? '--' }}</span>
      </span>
      <button class="session-delete-button" type="button" title="删除会话" @click.stop="emit('delete', session.id)">
        <UiIcon name="trash" :size="16" />
      </button>
    </article>

    <p v-if="!filteredSessions.length" class="session-empty-state">当前筛选下没有会话。</p>

    <teleport to="body">
      <div
        v-if="contextMenu"
        class="session-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      >
        <button type="button" @click="toggleFavorite(contextMenu.sessionId)">
          <UiIcon name="sparkles" :size="15" />
          {{ isFavorite(contextMenu.sessionId) ? '取消收藏' : '收藏会话' }}
        </button>
        <button type="button" class="danger" @click="deleteSession(contextMenu.sessionId)">
          <UiIcon name="trash" :size="15" />
          删除会话
        </button>
      </div>
    </teleport>
  </aside>
</template>
