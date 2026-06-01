<script setup lang="ts">
import { ElButton, ElInput } from 'element-plus'
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
      <el-button class="new-session-button" @click="emit('create')">
        <UiIcon name="plus" :size="19" :stroke-width="2.6" />
        新建会话
      </el-button>
      <el-button class="icon-button" title="更多">
        <UiIcon name="more" :size="19" />
      </el-button>
    </header>

    <label class="session-search">
      <UiIcon name="search" :size="18" />
      <el-input class="session-search__input" type="search" placeholder="搜索会话" />
      <el-button class="session-filter-button" title="筛选">
        <UiIcon name="filter" :size="17" />
      </el-button>
    </label>

    <div class="session-tabs">
      <el-button class="active">全部</el-button>
      <el-button>我创建的</el-button>
      <el-button>收藏</el-button>
    </div>

    <button
      v-for="(session, index) in sessions"
      :key="session.id"
      class="session-list-item"
      :class="{ active: session.id === currentSessionId }"
      type="button"
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
      <span
        class="session-delete"
        role="button"
        tabindex="0"
        title="删除会话"
        @click.stop="emit('delete', session.id)"
        @keydown.enter.stop.prevent="emit('delete', session.id)"
      >
        <UiIcon name="trash" :size="15" />
      </span>
    </button>
  </aside>
</template>

<!--
  Element Plus parity overrides.
  The EP theme is loaded globally (main.ts), so el-button/el-input arrive with
  EP's own box (padding, 14px font, wrapper <span>/<div>). These rules neutralise
  exactly those EP-introduced bits so the existing global .session-* classes in
  styles.css render the sidebar identically to the previous native markup.
  styles.css itself is left untouched.
-->
<style scoped>
/* Unwrap el-button's content <span> so icon + text rejoin the button's own
   flex/grid layout (restores the gap and lets place-items center the icon). */
.session-sidebar :deep(.el-button > span) {
  display: contents;
}

/* EP adds horizontal padding to every button; our buttons are sized by their
   own classes, so drop it. */
.session-sidebar :deep(.new-session-button),
.session-sidebar :deep(.icon-button),
.session-sidebar :deep(.session-filter-button),
.session-sidebar :deep(.session-tabs .el-button) {
  padding: 0;
}

/* EP buttons default to 14px; the old native "新建会话" inherited the page's
   16px. Set it on the wrapper span (the text's direct parent) so it also beats
   the legacy `.new-session-button span { font-size: 22px }` rule. */
.session-sidebar :deep(.new-session-button > span) {
  font-size: 16px;
}

/* Adjacent el-buttons get an EP left margin — the tab grid handles spacing. */
.session-sidebar :deep(.session-tabs .el-button + .el-button) {
  margin-left: 0;
}

/* Flatten el-input back to a bare input inside the flex search row. */
.session-sidebar :deep(.session-search__input) {
  width: 100%;
}
.session-sidebar :deep(.session-search__input .el-input__wrapper) {
  padding: 0;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  line-height: inherit;
}
</style>
