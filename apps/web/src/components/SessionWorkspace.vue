<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useSessionStore } from '@/stores/session'
import { sessionStatusLabel, type SessionStatus, type SessionViewMode } from '@/types/contracts'
import AgentStatusPanel from './AgentStatusPanel.vue'
import AgentPortrait from './AgentPortrait.vue'
import ChatTimeline from './ChatTimeline.vue'
import CollaborationGraphView from './CollaborationGraphView.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import SessionSidebar from './SessionSidebar.vue'
import UiIcon from './UiIcon.vue'
import UserInputBox from './UserInputBox.vue'
import WorkflowRuntimeView from './WorkflowRuntimeView.vue'

const sessionStore = useSessionStore()
const eventStore = useEventStore()
const agentStore = useAgentStore()
const knowledgeStore = useKnowledgeStore()
const isSendingMessage = ref(false)
const inputError = ref('')
const showAgentPopover = ref(false)

const viewModes: SessionViewMode[] = ['chat', 'workflow', 'collaboration_graph']
const DEFAULT_AGENT_KEYS = ['coordinator', 'requirements', 'backend', 'test', 'review']
const DEFAULT_SESSION_INPUT = 'Run the v0.1 multi-agent collaboration dry-run main chain.'

function isViewMode(value: string | null): value is SessionViewMode {
  return value === 'chat' || value === 'collaboration_graph' || value === 'workflow'
}

function viewModeLabel(mode: SessionViewMode) {
  return (
    {
      chat: '对话',
      collaboration_graph: '协同看板',
      workflow: '工作流'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

function viewModeIcon(mode: SessionViewMode) {
  return (
    {
      chat: 'message',
      collaboration_graph: 'graph',
      workflow: 'workflow'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

onMounted(async () => {
  const view = new URLSearchParams(window.location.search).get('view')
  if (isViewMode(view)) {
    sessionStore.switchViewMode(view)
  }

  await Promise.all([
    agentStore.loadAgents(),
    agentStore.loadCapabilities(),
    knowledgeStore.loadKnowledgeBases(),
    sessionStore.loadSessions()
  ])
  await sessionStore.loadSession()
  if (sessionStore.currentSession) {
    await eventStore.loadEvents(sessionStore.currentSession.id)
    eventStore.connectSse(sessionStore.currentSession.id)
  }
})

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const events = computed(() => eventStore.eventsForSession(currentSessionId.value))
const messages = computed(() => eventStore.chatMessages(currentSessionId.value))
const agents = computed(() => eventStore.agentCards(currentSessionId.value))
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const currentMode = computed(() => sessionStore.currentViewMode)

const derivedStatus = computed(() => {
  const statusEvent = [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .find((event) => event.type === 'session_status_changed')
  return (statusEvent?.metadata.payload?.status as SessionStatus | undefined) ?? sessionStore.currentSession?.status
})

const completedTaskCount = computed(() => tasks.value.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!tasks.value.length) return 0
  return Math.round((completedTaskCount.value / tasks.value.length) * 100)
})

async function selectSession(sessionId: string) {
  await sessionStore.loadSession(sessionId)
  await eventStore.loadEvents(sessionId)
  eventStore.connectSse(sessionId)
}

async function createSession(input = DEFAULT_SESSION_INPUT) {
  const session = await sessionStore.createSession({
    input,
    agentIds: DEFAULT_AGENT_KEYS,
    tokenBudget: 30000
  })
  await eventStore.loadEvents(session.id)
  eventStore.connectSse(session.id)
}

async function sendUserMessage(content: string) {
  inputError.value = ''
  isSendingMessage.value = true
  try {
    if (!sessionStore.currentSession) {
      await createSession(content)
      return
    }

    const sessionId = sessionStore.currentSession.id
    await sessionStore.sendMessage(sessionId, content)
    await eventStore.loadEvents(sessionId)
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '发送失败'
  } finally {
    isSendingMessage.value = false
  }
}

async function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  if (optionKey === 'approve' && activeConfirmation.value.relatedBriefId) {
    await sessionStore.confirmBrief(sessionStore.currentSession.id, activeConfirmation.value.relatedBriefId)
    await eventStore.loadEvents(sessionStore.currentSession.id)
    return
  }
  eventStore.appendEvent({
    id: `evt-local-${Date.now()}`,
    sessionId: sessionStore.currentSession.id,
    type: 'user_confirmation_resolved',
    toAgentIds: ['agent-coordinator'],
    content: `User selected ${optionKey}`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        confirmationId: activeConfirmation.value.confirmationId,
        status: optionKey === 'approve' ? 'approved' : 'rejected',
        selectedOptionKey: optionKey
      }
    },
    createdAt: new Date().toISOString()
  })
}
</script>

<template>
  <div :class="['workspace-shell', `mode-${currentMode}`]">
    <nav class="app-rail" aria-label="Primary navigation">
      <div class="brand-mark" aria-hidden="true">
        <span v-for="index in 6" :key="index"></span>
      </div>
      <div class="rail-nav">
      <button
        v-for="mode in viewModes"
        :key="mode"
        type="button"
        :class="['rail-button', { active: currentMode === mode }]"
        :title="viewModeLabel(mode)"
        @click="sessionStore.switchViewMode(mode)"
      >
        <UiIcon :name="viewModeIcon(mode)" :size="24" />
        <span>{{ viewModeLabel(mode) }}</span>
      </button>
      <button class="rail-button" type="button" title="知识库">
        <UiIcon name="database" :size="24" />
        <span>知识库</span>
      </button>
      <button class="rail-button" type="button" title="设置">
        <UiIcon name="settings" :size="24" />
        <span>设置</span>
      </button>
      <button class="rail-button" type="button" title="模型管理">
        <UiIcon name="bot" :size="24" />
        <span>模型管理</span>
      </button>
      <button class="rail-button" type="button" title="工具集成">
        <UiIcon name="sparkles" :size="24" />
        <span>工具集成</span>
      </button>
      <button class="rail-button" type="button" title="通知中心">
        <UiIcon name="bell" :size="24" />
        <span>通知中心</span>
      </button>
      </div>
      <div class="rail-user">
        <AgentPortrait :tone="4" label="张三" size="sm" />
        <strong>张三</strong>
        <small>在线</small>
      </div>
    </nav>

    <SessionSidebar
      :sessions="sessionStore.sessions"
      :current-session-id="sessionStore.currentSession?.id"
      @select="selectSession"
      @create="createSession"
    />

    <section class="workspace-main">
      <header class="workspace-header">
        <div class="workspace-title">
          <h1>{{ sessionStore.currentSession?.title ?? '多 Agent 协同工作平台' }}</h1>
          <p>{{ sessionStore.currentSession?.originalInput ?? '创建会话或输入任务，启动多 Agent 协作。' }}</p>
        </div>
        <div class="workspace-actions">
          <div v-if="currentMode === 'chat'" class="chat-agent-menu">
            <button class="chat-group-pill" type="button" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="16" />
              群聊 · {{ Math.max(agents.length, 5) }} Agents
            </button>
            <button class="chat-avatar-stack" type="button" aria-label="查看所有 Agent" @click="showAgentPopover = !showAgentPopover">
              <AgentPortrait
                v-for="(agent, index) in agents.slice(0, 5)"
                :key="agent.agentId"
                :tone="(index % 5) + 1"
                :label="agent.name"
                size="sm"
              />
              <b v-if="agents.length > 5">+{{ agents.length - 5 }}</b>
            </button>
            <button class="header-icon-button" type="button" title="查看所有 Agent" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="18" />
              <span>{{ agents.length }}</span>
            </button>
            <section v-if="showAgentPopover" class="agent-popover" aria-label="所有 Agent">
              <header>
                <strong>全部 Agent</strong>
                <span>{{ agents.length }} 个成员</span>
              </header>
              <article v-for="(agent, index) in agents" :key="agent.agentId">
                <AgentPortrait :tone="(index % 5) + 1" :label="agent.name" size="sm" />
                <div>
                  <strong>{{ agent.name }}</strong>
                  <p>{{ agent.role }}</p>
                </div>
                <span :class="['agent-status', agent.status]">{{ agent.status }}</span>
              </article>
            </section>
          </div>
          <span v-if="currentMode !== 'chat'" class="project-chip">项目：智能营销方案制定</span>
          <span v-if="currentMode !== 'chat'" class="progress-chip">
            整体进度
            <strong>{{ progressPercent }}%</strong>
            <span><i :style="{ width: `${progressPercent}%` }"></i></span>
          </span>
          <span v-if="derivedStatus" class="session-state">{{ sessionStatusLabel[derivedStatus] }}</span>
          <button
            v-for="mode in viewModes"
            :key="mode"
            type="button"
            :class="['mode-button', { active: currentMode === mode }]"
            @click="sessionStore.switchViewMode(mode)"
          >
            <UiIcon :name="viewModeIcon(mode)" :size="16" />
            {{ viewModeLabel(mode) }}
          </button>
        </div>
      </header>

      <div class="workspace-content">
        <div v-if="currentMode === 'chat'" class="chat-pane">
          <ChatTimeline :messages="messages" @resolve-confirmation="resolveConfirmation" />
          <UserInputBox :busy="isSendingMessage" :error="inputError" @send="sendUserMessage" />
        </div>
        <CollaborationGraphView
          v-else-if="currentMode === 'collaboration_graph'"
          :events="events"
          :agents="agents"
        />
        <WorkflowRuntimeView
          v-else
          :events="events"
          :tasks="tasks"
          :active-confirmation="activeConfirmation"
          :status="derivedStatus"
        />
      </div>
    </section>

    <CollaborationLogPanel
      v-if="currentMode === 'collaboration_graph'"
      :events="events"
      :agents="agents"
    />
    <AgentStatusPanel
      v-else
      :agents="agents"
      :tasks="tasks"
      :active-confirmation="activeConfirmation"
      :connected="eventStore.sseConnected"
      @resolve-confirmation="resolveConfirmation"
    />
  </div>
</template>
