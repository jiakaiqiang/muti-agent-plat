<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import type { SessionArchiveGroup, SessionListItem, SessionStatus } from '@/types/contracts'
import UiIcon from '@/components/UiIcon.vue'
import { listableTab } from '@/utils/sessionList'
import { groupVisibleSessions } from './workspace/sessionListModel'

type SessionStatusTone = 'draft' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

const sessionStatusPresentation: Record<SessionStatus, { label: string; tone: SessionStatusTone }> = {
  DRAFT_INPUT: { label: '待理解', tone: 'draft' },
  WAIT_SOURCE_PREPARATION: { label: '准备仓库', tone: 'waiting' },
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

const props = withDefaults(defineProps<{
  sessions: SessionListItem[]
  currentSessionId?: string
  favoriteSessionIds: string[]
  deletingSessionIds: string[]
  archiveGroups?: SessionArchiveGroup[]
}>(), { archiveGroups: () => [] })

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  delete: [sessionId: string]
  archive: [sessionId: string]
  restoreArchive: [sessionId: string]
  toggleFavorite: [sessionId: string]
}>()

const workspaceUiStore = useWorkspaceUiStore()
const { sessionListTab: activeTab } = storeToRefs(workspaceUiStore)
type SessionMenuKind = 'active' | 'archived'
const contextMenu = ref<{ sessionId: string; x: number; y: number; kind: SessionMenuKind } | undefined>()

const favoriteIds = computed(() => new Set(props.favoriteSessionIds))
const deletingIds = computed(() => new Set(props.deletingSessionIds))

const sessionGroups = computed(() =>
  activeTab.value === 'archives' ? [] : groupVisibleSessions(props.sessions, listableTab(activeTab.value), props.favoriteSessionIds))

function openContextMenu(event: MouseEvent, sessionId: string, kind: SessionMenuKind) {
  event.preventDefault()
  contextMenu.value = {
    sessionId,
    x: event.clientX,
    y: Math.max(12, event.clientY - 12),
    kind
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

function archiveSession(sessionId: string) {
  if (isDeletingSession(sessionId)) return
  emit('archive', sessionId)
  closeContextMenu()
}

function restoreArchive(sessionId: string) {
  emit('restoreArchive', sessionId)
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

function lifecycleLabel(session: Pick<SessionListItem, 'status' | 'lifecycleState'>) {
  if (session.lifecycleState === 'deleting') return '删除中'
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
        新建任务
      </button>
      <button class="icon-button" type="button" title="更多">
        <UiIcon name="more" :size="19" />
      </button>
    </header>

    <div class="session-tabs">
      <button type="button" :class="{ active: activeTab === 'all' }" @click="activeTab = 'all'">全部</button>
      <button type="button" :class="{ active: activeTab === 'mine' }" @click="activeTab = 'mine'">我创建的</button>
      <button type="button" :class="{ active: activeTab === 'favorites' }" @click="activeTab = 'favorites'">收藏</button>
      <button type="button" :class="{ active: activeTab === 'archives' }" @click="activeTab = 'archives'">归档管理</button>
    </div>

    <section v-if="activeTab === 'archives'" class="session-archive-manager" aria-label="归档管理">
      <section v-for="group in props.archiveGroups" :key="group.projectKey" class="task-project-group">
        <h3 :title="group.projectLabel">{{ group.projectLabel }}</h3>
        <article
          v-for="item in group.items"
          :key="item.id"
          class="session-list-item"
          @contextmenu="openContextMenu($event, item.id, 'archived')"
        >
          <span class="session-item-main">
            <span class="session-title">{{ item.title }}</span>
            <span
              :class="['session-status-badge', `status-${sessionStatus(item.status).tone}`]"
              :aria-label="`会话状态：${lifecycleLabel(item)}`"
              :title="lifecycleLabel(item)"
            >
              {{ lifecycleLabel(item) }}
            </span>
          </span>
          <button
            class="session-more-button"
            type="button"
            title="更多操作"
            :disabled="isDeletingSession(item.id)"
            @click.stop="openContextMenu($event, item.id, 'archived')"
          >
            <UiIcon name="more" :size="16" />
          </button>
        </article>
      </section>
      <p v-if="!props.archiveGroups.length" class="session-empty-state">暂无归档会话。</p>
    </section>

    <template v-if="activeTab !== 'archives'">
      <section v-for="group in sessionGroups" :key="group.key" class="task-project-group">
      <h3 :title="group.label">{{ group.label }}</h3>
      <article
        v-for="session in group.sessions"
        :key="session.id"
        class="session-list-item"
        :class="{ active: session.id === currentSessionId, favorite: isFavorite(session.id) }"
        role="button"
        tabindex="0"
        @keydown.enter="emit('select', session.id)"
        @keydown.space.prevent="emit('select', session.id)"
        @click="emit('select', session.id)"
        @contextmenu="openContextMenu($event, session.id, 'active')"
      >
      <span class="session-item-main">
        <span class="session-title">{{ session.title }}</span>
        <span
          :class="['session-status-badge', `status-${sessionStatus(session.status).tone}`]"
          :aria-label="`会话状态：${lifecycleLabel(session)}`"
          :title="lifecycleLabel(session)"
        >
          {{ lifecycleLabel(session) }}
        </span>
      </span>
      <button
        class="session-more-button"
        type="button"
        title="更多操作"
        :disabled="isDeletingSession(session.id)"
        @click.stop="openContextMenu($event, session.id, 'active')"
      >
        <UiIcon name="more" :size="16" />
      </button>
      </article>
      </section>
    </template>

    <p v-if="activeTab !== 'archives' && !sessionGroups.length" class="session-empty-state">当前筛选下没有会话。</p>

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
        <button v-if="contextMenu.kind === 'archived'"
          type="button"
          @click="restoreArchive(contextMenu.sessionId)"
        >
          <UiIcon name="refresh-cw" :size="15" />
          恢复归档
        </button>
        <button v-if="contextMenu.kind === 'active'"
          type="button"
          class="warning"
          :disabled="isDeletingSession(contextMenu.sessionId)"
          @click="archiveSession(contextMenu.sessionId)"
        >
          <UiIcon name="archive" :size="15" />
          归档会话
        </button>
        <button
          type="button"
          class="danger"
          :disabled="isDeletingSession(contextMenu.sessionId)"
          @click="deleteSession(contextMenu.sessionId)"
        >
          <UiIcon name="trash" :size="15" />
          删除会话
        </button>
      </div>
    </teleport>
  </aside>
</template>

<style scoped>
.task-project-group { min-width: 0; }
.task-project-group h3 { padding: 12px 16px 4px; margin: 0; font-size: 12px; font-weight: 500; color: #606266; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
