<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import type { SessionListItem, SessionStatus } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

type SessionStatusTone = 'draft' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

const sessionStatusPresentation: Record<SessionStatus, { label: string; tone: SessionStatusTone }> = {
  DRAFT_INPUT: { label: '待理解', tone: 'draft' },
  AGENT_DISCUSSING: { label: '讨论中', tone: 'running' },
  WAIT_USER_CONFIRM: { label: '待确认', tone: 'waiting' },
  WAIT_WORKFLOW_SELECT: { label: '选流程', tone: 'waiting' },
  WAIT_WORKFLOW_STEP_CONFIRM: { label: '待确认', tone: 'waiting' },
  REVISING_BRIEF: { label: '修订中', tone: 'running' },
  EXECUTING: { label: '执行中', tone: 'running' },
  POST_REVIEW: { label: '复盘中', tone: 'running' },
  REWORKING: { label: '返工中', tone: 'running' },
  APPLYING_CHANGES: { label: '写回中', tone: 'running' },
  WAIT_WORKSPACE_CONFLICT_RESOLUTION: { label: '待处理冲突', tone: 'waiting' },
  WAIT_USER_DECISION: { label: '待决策', tone: 'waiting' },
  PAUSED: { label: '已停止', tone: 'waiting' },
  INTERRUPTED: { label: '已中断', tone: 'waiting' },
  COMPLETED: { label: '已完成', tone: 'completed' },
  FAILED: { label: '失败', tone: 'failed' },
  CANCELLED: { label: '已取消', tone: 'cancelled' }
}

const props = defineProps<{
  sessions: SessionListItem[]
  currentSessionId?: string
  favoriteSessionIds: string[]
  deletingSessionIds: string[]
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  delete: [sessionId: string]
  restore: [sessionId: string]
  toggleFavorite: [sessionId: string]
}>()

const workspaceUiStore = useWorkspaceUiStore()
const { sessionListTab: activeTab, sessionSearchQuery: search } = storeToRefs(workspaceUiStore)
const contextMenu = ref<{ sessionId: string; x: number; y: number } | undefined>()

const favoriteIds = computed(() => new Set(props.favoriteSessionIds))
const deletingIds = computed(() => new Set(props.deletingSessionIds))

const filteredSessions = computed(() => {
  const query = search.value.trim().toLowerCase()
  return props.sessions.filter((session) => {
    const deleted = session.lifecycleState === 'deleted'
    if (activeTab.value === 'deleted' ? !deleted : deleted) return false
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
  if (isDeletingSession(sessionId)) return
  emit('delete', sessionId)
  closeContextMenu()
}

function restoreSession(sessionId: string) {
  emit('restore', sessionId)
  closeContextMenu()
}

function isFavorite(sessionId: string) {
  return favoriteIds.value.has(sessionId)
}

function isDeletingSession(sessionId: string) {
  return deletingIds.value.has(sessionId)
}

function sessionStatus(status: SessionStatus) {
  return sessionStatusPresentation[status]
}

function lifecycleLabel(session: SessionListItem) {
  if (session.lifecycleState === 'deleting') return '删除中'
  if (session.lifecycleState === 'deleted') return '已删除'
  return sessionStatus(session.status).label
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
      <button type="button" :class="{ active: activeTab === 'deleted' }" @click="activeTab = 'deleted'">已删除</button>
    </div>

    <article
      v-for="(session, index) in filteredSessions"
      :key="session.id"
      class="session-list-item"
      :class="{ active: session.id === currentSessionId, favorite: isFavorite(session.id) }"
      @click="session.lifecycleState !== 'deleted' && emit('select', session.id)"
      @contextmenu="openContextMenu($event, session.id)"
    >
      <span class="session-avatar">
        <AgentPortrait :tone="(index % 5) + 1" :label="session.title" size="md" />
        <span
          :class="['session-status-badge', `status-${sessionStatus(session.status).tone}`]"
          :aria-label="`会话状态：${lifecycleLabel(session)}`"
          :title="lifecycleLabel(session)"
        >
          {{ lifecycleLabel(session) }}
        </span>
      </span>
      <span class="session-item-main">
        <span class="session-title">{{ session.title }}</span>
      </span>
      <button
        class="session-delete-button"
        type="button"
        :title="session.lifecycleState === 'deleted' ? '恢复会话' : '删除会话'"
        :disabled="isDeletingSession(session.id)"
        @click.stop="session.lifecycleState === 'deleted' ? restoreSession(session.id) : deleteSession(session.id)"
      >
        <UiIcon :name="session.lifecycleState === 'deleted' ? 'refresh-cw' : 'trash'" :size="16" />
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
        <button v-if="props.sessions.find(item => item.id === contextMenu?.sessionId)?.lifecycleState !== 'deleted'"
          type="button"
          class="danger"
          :disabled="isDeletingSession(contextMenu.sessionId)"
          @click="deleteSession(contextMenu.sessionId)"
        >
          <UiIcon name="trash" :size="15" />
          删除会话
        </button>
        <button v-else type="button" @click="restoreSession(contextMenu.sessionId)">
          <UiIcon name="refresh-cw" :size="15" />
          恢复会话
        </button>
      </div>
    </teleport>
  </aside>
</template>
