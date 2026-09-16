<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'
import { taskActivity } from '@/utils/taskActivity'
import UiIcon from './UiIcon.vue'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    busy?: boolean
    placeholder?: string
    error?: string
    canStop?: boolean
    canResume?: boolean
    controlBusy?: boolean
    controlError?: string
  }>(),
  {
    disabled: false,
    busy: false,
    placeholder: '输入消息...（支持 @agent / #知识库 / 发送文件）'
  }
)

const emit = defineEmits<{
  send: [content: string]
  stop: []
  resume: []
}>()

const workspaceUiStore = useWorkspaceUiStore()
const sessionStore = useSessionStore()
const eventStore = useEventStore()
const now = ref(Date.now())
let activityTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { activityTimer = setInterval(() => { now.value = Date.now() }, 5000) })
onBeforeUnmount(() => { clearInterval(activityTimer) })
const activity = computed(() => taskActivity({
  session: sessionStore.currentSession,
  events: sessionStore.currentSession ? eventStore.eventsForSession(sessionStore.currentSession.id) : [],
  connectedSessionId: eventStore.connectedSessionId,
  connectionState: eventStore.sseConnectionState,
  unavailable: props.disabled,
  now: now.value
}))
const { messageDraft: draft } = storeToRefs(workspaceUiStore)
const action = computed(() => props.canStop || (props.busy && !props.canResume)
  ? 'stop' : props.canResume && !draft.value.trim() ? 'resume' : 'send')
const canSend = computed(() => action.value === 'send' && draft.value.trim().length > 0 && !props.disabled && !props.busy && !props.controlBusy)
const actionLabel = computed(() => action.value === 'stop' ? '停止当前会话' : action.value === 'resume' ? '继续当前会话' : '发送')
const actionDisabled = computed(() => action.value === 'send' ? !canSend.value : props.controlBusy || props.disabled)
const actionPendingLabel = computed(() => action.value === 'stop' ? '正在停止当前会话' : '正在继续当前会话')

function activateAction() {
  if (actionDisabled.value) return
  if (action.value === 'stop') emit('stop')
  else if (action.value === 'resume') emit('resume')
  else submit()
}

function submit() {
  const content = draft.value.trim()
  if (!content || !canSend.value) return
  emit('send', content)
  draft.value = ''
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <footer class="user-input-box" :class="{ 'has-task-activity': activity }" aria-label="User input">
    <p v-if="activity" class="task-activity" :class="`is-${activity.tone}`" role="status" aria-live="polite" aria-atomic="true">
      <span class="task-activity__dot" aria-hidden="true"></span>{{ activity.text }}
    </p>
    <div class="input-tools" aria-hidden="true">
      <span class="tool-dot"><UiIcon name="paperclip" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="image" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="code" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="at" :size="18" /></span>
    </div>
    <textarea
      v-model="draft"
      :placeholder="placeholder"
      :disabled="disabled || busy"
      rows="2"
      @keydown="handleKeydown"
    />
    <div class="user-input-box__actions">
      <p v-if="controlError || error" class="input-error" role="alert">{{ controlError || error }}</p>
      <button class="send-button composer-action" :class="`is-${action}`" type="button"
        :disabled="actionDisabled" :aria-busy="controlBusy || undefined" :aria-label="actionLabel"
        :title="controlBusy ? actionPendingLabel : actionLabel" @click="activateAction">
        <span v-if="controlBusy" class="composer-action__spinner" aria-hidden="true"></span>
        <UiIcon v-else :name="action === 'stop' ? 'stop' : action === 'resume' ? 'play' : 'send'" :size="21" :stroke-width="2.4" />
        <span v-if="controlBusy" class="composer-action__status" role="status">{{ actionPendingLabel }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.user-input-box { position: relative; }
.composer-action { flex-shrink: 0; cursor: pointer; transition: opacity 160ms; }
.composer-action:hover:not(:disabled) { opacity: .85; }
.composer-action:disabled { cursor: not-allowed; opacity: .6; }
.composer-action:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
.composer-action__spinner { width: 18px; height: 18px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: composer-spin .8s linear infinite; }
.composer-action__status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes composer-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .composer-action__spinner { animation: none; } }
.user-input-box.has-task-activity { margin-top: 32px; }
.task-activity {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: #606266;
}
.task-activity.is-running { color: #337ecc; }
.task-activity.is-warning { color: #8d5706; }
.task-activity__dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
.is-running .task-activity__dot { animation: task-activity-pulse 1.5s ease-in-out infinite; }
@keyframes task-activity-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) { .task-activity__dot { animation: none; } }
</style>
