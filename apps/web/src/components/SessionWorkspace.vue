<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useModelStore } from '@/stores/model'
import { useSessionStore } from '@/stores/session'
import { sessionStatusLabel, type AgentCardState, type SessionStatus, type SessionViewMode } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ChatTimeline from './ChatTimeline.vue'
import CollaborationGraphView from './CollaborationGraphView.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import ConfirmationCard from './ConfirmationCard.vue'
import DebugRuntimeView from './DebugRuntimeView.vue'
import ModelManagementPanel from './ModelManagementPanel.vue'
import SessionSidebar from './SessionSidebar.vue'
import UiIcon from './UiIcon.vue'
import UserInputBox from './UserInputBox.vue'
import WorkflowRuntimeView from './WorkflowRuntimeView.vue'

const sessionStore = useSessionStore()
const eventStore = useEventStore()
const agentStore = useAgentStore()
const knowledgeStore = useKnowledgeStore()
const modelStore = useModelStore()

const isSendingMessage = ref(false)
const inputError = ref('')
const showAgentPopover = ref(false)
const showCreateSessionDialog = ref(false)
const isCreatingSession = ref(false)
const newSessionInput = ref('')
const selectedSessionAgentIds = ref<string[]>([])
const sessionCreateError = ref('')

type WorkspaceSection = 'session' | 'knowledge' | 'agents' | 'settings' | 'models' | 'tools' | 'notifications'

const viewModes: SessionViewMode[] = ['chat', 'workflow', 'collaboration_graph', 'debug']
const activeSection = ref<WorkspaceSection>('session')

const railSections: Array<{ id: WorkspaceSection; label: string; icon: string }> = [
  { id: 'session', label: '工作台', icon: 'message' },
  { id: 'knowledge', label: '知识库', icon: 'database' },
  { id: 'agents', label: 'Agent 管理', icon: 'bot' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'models', label: '模型管理', icon: 'cpu' },
  { id: 'tools', label: '工具集成', icon: 'sparkles' },
  { id: 'notifications', label: '通知中心', icon: 'bell' }
]

function isViewMode(value: string | null): value is SessionViewMode {
  return value === 'chat' || value === 'collaboration_graph' || value === 'workflow' || value === 'debug'
}

function viewModeLabel(mode: SessionViewMode) {
  return (
    {
      chat: '对话',
      collaboration_graph: '协同看板',
      workflow: '工作流',
      debug: '调试'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

function viewModeIcon(mode: SessionViewMode) {
  return (
    {
      chat: 'message',
      collaboration_graph: 'graph',
      workflow: 'workflow',
      debug: 'debug'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

function activateRailSection(section: WorkspaceSection) {
  activeSection.value = section
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
    modelStore.loadModels(),
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
const agents = computed(() => {
  const cards = eventStore.agentCards(currentSessionId.value)
  const participating = sessionStore.currentSession?.participatingAgentIds
  if (!participating?.length) return cards
  const allowed = new Set(participating)
  return cards.filter((card) => allowed.has(card.agentId))
})
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const currentMode = computed(() => sessionStore.currentViewMode)
const primaryAgent = computed(() => agents.value[0])
const workspaceLabel = computed(() => sessionStore.currentSession?.title ?? '无活动会话')
const activeAgentIds = computed(() => agentStore.agents.filter((agent) => agent.status === 'active').map((agent) => agent.id))

// IDs of agents optimistically marked as running while a brand-new session's brief is being planned.
// The session's SSE is already connected by then (createSession connects before resolving), so once
// real per-agent agent_status_changed events arrive they take over; the overlay only fills agents
// whose real status is still 'idle', never masking a live backend status. It is NOT used for
// messages to an existing session — those rely entirely on the real status events.
const planningAgentIds = ref<string[]>([])
const displayAgents = computed<AgentCardState[]>(() =>
  agents.value.map((agent) =>
    planningAgentIds.value.includes(agent.agentId) && agent.status === 'idle'
      ? { ...agent, status: 'running' }
      : agent
  )
)

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

async function deleteSessionFromSidebar(sessionId: string) {
  if (!window.confirm('确定删除该会话吗？该操作不可恢复。')) {
    return
  }
  const wasCurrent = sessionStore.currentSession?.id === sessionId
  if (wasCurrent) {
    eventStore.disconnectSse()
  }
  try {
    await sessionStore.deleteSession(sessionId)
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '删除会话失败'
    return
  }
  if (wasCurrent && sessionStore.sessions[0]) {
    await selectSession(sessionStore.sessions[0].id)
  }
}

async function createSession(input: string, agentIds: string[]) {
  const session = await sessionStore.createSession({
    input,
    agentIds,
    tokenBudget: 30000
  })
  await eventStore.loadEvents(session.id)
  eventStore.connectSse(session.id)
}

function openCreateSessionDialog() {
  sessionCreateError.value = ''
  newSessionInput.value = ''
  selectedSessionAgentIds.value = activeAgentIds.value
  showCreateSessionDialog.value = true
}

function toggleSessionAgent(agentId: string) {
  selectedSessionAgentIds.value = selectedSessionAgentIds.value.includes(agentId)
    ? selectedSessionAgentIds.value.filter((id) => id !== agentId)
    : [...selectedSessionAgentIds.value, agentId]
}

async function createSessionFromDialog() {
  const input = newSessionInput.value.trim()
  if (!agentStore.agents.length) {
    sessionCreateError.value = '请先添加 Agent'
    return
  }
  if (!input) {
    sessionCreateError.value = '请填写会话任务'
    return
  }
  if (!selectedSessionAgentIds.value.length) {
    sessionCreateError.value = '请选择至少一个 Agent'
    return
  }

  isCreatingSession.value = true
  sessionCreateError.value = ''
  try {
    await createSession(input, selectedSessionAgentIds.value)
    showCreateSessionDialog.value = false
  } catch (error) {
    sessionCreateError.value = error instanceof Error ? error.message : '创建会话失败'
  } finally {
    isCreatingSession.value = false
  }
}

const showModelAgentForm = ref(false)
const isSavingModelAgent = ref(false)
const modelAgentError = ref('')
const modelAgentName = ref('')
const modelAgentRole = ref('')
const modelAgentTags = ref('')
const modelAgentCapabilityIds = ref<string[]>([])
const modelAgentModelId = ref('')
const tasksExpanded = ref(false)

function resetModelAgentForm() {
  modelAgentName.value = ''
  modelAgentRole.value = ''
  modelAgentTags.value = ''
  modelAgentCapabilityIds.value = []
  modelAgentModelId.value = ''
  modelAgentError.value = ''
}

function toggleModelAgentForm() {
  showModelAgentForm.value = !showModelAgentForm.value
  if (!showModelAgentForm.value) {
    resetModelAgentForm()
  }
}

function toggleModelAgentCapability(capabilityId: string) {
  modelAgentCapabilityIds.value = modelAgentCapabilityIds.value.includes(capabilityId)
    ? modelAgentCapabilityIds.value.filter((id) => id !== capabilityId)
    : [...modelAgentCapabilityIds.value, capabilityId]
}

function getModelName(modelId?: string) {
  if (!modelId) return ''
  return modelStore.models.find(m => m.id === modelId)?.name ?? modelId
}

function configuredAgentCard(agentId: string) {
  return agentStore.agents.find((agent) => agent.id === agentId)
}

function agentCapabilityNames(agent: AgentCardState) {
  const configured = configuredAgentCard(agent.agentId)
  const configuredNames = (configured?.capabilityIds ?? []).map((id) => agentStore.capabilityName(id))
  return agent.activeCapabilityNames.length ? agent.activeCapabilityNames : configuredNames
}

function statusLabel(status: string) {
  return (
    {
      idle: '空闲',
      running: '运行中',
      thinking: '思考中',
      discussing: '讨论中',
      waiting: '等待中',
      reviewing: '复盘中',
      reworking: '返工中',
      completed: '已完成',
      failed: '失败',
      disabled: '停用',
      pending: '待处理',
      claimed: '已领取',
      rejected: '已拒绝',
      cancelled: '已取消'
    }[status] ?? status
  )
}

async function submitModelAgentForm() {
  const name = modelAgentName.value.trim()
  const role = modelAgentRole.value.trim()
  if (!name || !role) {
    modelAgentError.value = '请填写 Agent 名称和能力描述'
    return
  }

  isSavingModelAgent.value = true
  modelAgentError.value = ''
  try {
    await agentStore.createAgent({
      name,
      role,
      tags: modelAgentTags.value
        .split(/[,\n\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      capabilityIds: modelAgentCapabilityIds.value,
      modelId: modelAgentModelId.value || undefined
    })
    resetModelAgentForm()
    showModelAgentForm.value = false
  } catch (error) {
    modelAgentError.value = error instanceof Error ? error.message : '创建 Agent 失败'
  } finally {
    isSavingModelAgent.value = false
  }
}

async function removeAgentFromAdmin(agentId: string, name: string) {
  if (!window.confirm(`确定删除 Agent “${name}”吗？该操作不可恢复。`)) {
    return
  }
  try {
    await agentStore.deleteAgent(agentId)
  } catch (error) {
    modelAgentError.value = error instanceof Error ? error.message : '删除 Agent 失败'
  }
}

async function sendUserMessage(content: string) {
  inputError.value = ''
  isSendingMessage.value = true
  try {
    if (!sessionStore.currentSession) {
      if (!activeAgentIds.value.length) {
        inputError.value = '请先添加 Agent'
        return
      }
      planningAgentIds.value = [...activeAgentIds.value]
      await createSession(content, activeAgentIds.value)
      return
    }

    // Existing session: the brief is confirmed/executing and SSE is connected, so the real
    // agent_status_changed events drive the cards. No optimistic overlay here.
    const sessionId = sessionStore.currentSession.id
    await sessionStore.sendMessage(sessionId, content)
    await eventStore.loadEvents(sessionId)
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '发送失败'
  } finally {
    isSendingMessage.value = false
    planningAgentIds.value = []
  }
}

async function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  const sessionId = sessionStore.currentSession.id
  if (optionKey === 'approve' && activeConfirmation.value.relatedBriefId) {
    await sessionStore.confirmBrief(sessionId, activeConfirmation.value.relatedBriefId)
    await eventStore.loadEvents(sessionId)
    return
  }

  if (activeConfirmation.value.reason === 'resolve_contract_conflict') {
    if (optionKey === 'resume') {
      await sessionStore.resumeSession(sessionId, activeConfirmation.value.confirmationId)
    } else if (optionKey === 'cancel') {
      await sessionStore.cancelSession(sessionId, activeConfirmation.value.confirmationId)
    }
    await eventStore.loadEvents(sessionId)
    return
  }

  eventStore.appendEvent({
    id: `evt-local-${Date.now()}`,
    sessionId,
    type: 'user_confirmation_resolved',
    toAgentIds: [],
    content: `用户选择了 ${optionKey}`,
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
  <div :class="['workspace-shell', activeSection === 'session' ? `mode-${currentMode}` : 'mode-admin', `section-${activeSection}`]">
    <nav class="app-rail" aria-label="主导航">
      <div class="brand-mark" aria-hidden="true">
        <span v-for="index in 6" :key="index"></span>
      </div>
      <div class="rail-nav">
        <button
          v-for="section in railSections"
          :key="section.id"
          type="button"
          :class="['rail-button', { active: activeSection === section.id }]"
          :title="section.label"
          @click="activateRailSection(section.id)"
        >
          <UiIcon :name="section.icon" :size="24" />
          <span>{{ section.label }}</span>
        </button>
      </div>
      <div class="rail-user">
        <AgentPortrait :tone="4" :label="primaryAgent?.name ?? 'Agent Cluster'" size="sm" />
        <strong>{{ primaryAgent?.name ?? 'Agent Cluster' }}</strong>
        <small>{{ primaryAgent?.status ?? 'idle' }}</small>
      </div>
    </nav>

    <SessionSidebar
      v-if="activeSection === 'session'"
      :sessions="sessionStore.sessions"
      :current-session-id="sessionStore.currentSession?.id"
      @select="selectSession"
      @create="openCreateSessionDialog"
      @delete="deleteSessionFromSidebar"
    />

    <section v-if="activeSection === 'session'" class="workspace-main">
      <header class="workspace-header">
        <div class="workspace-title">
          <h1>{{ sessionStore.currentSession?.title ?? '多 Agent 协同工作平台' }}</h1>
          <p>{{ sessionStore.currentSession?.originalInput ?? '创建会话或输入任务，启动多 Agent 协作。' }}</p>
        </div>
        <div class="workspace-actions">
          <div v-if="currentMode === 'chat'" class="chat-agent-menu">
            <button class="chat-group-pill" type="button" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="16" />
              群聊 · {{ agents.length }} Agents
            </button>
            <button class="chat-avatar-stack" type="button" aria-label="查看全部 Agent" @click="showAgentPopover = !showAgentPopover">
              <AgentPortrait
                v-for="(agent, index) in agents.slice(0, 5)"
                :key="agent.agentId"
                :tone="(index % 5) + 1"
                :label="agent.name"
                size="sm"
              />
              <b v-if="agents.length > 5">+{{ agents.length - 5 }}</b>
            </button>
            <button class="header-icon-button" type="button" title="查看全部 Agent" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="18" />
              <span>{{ agents.length }}</span>
            </button>
            <section v-if="showAgentPopover" class="agent-popover" aria-label="全部 Agent">
              <header>
                <strong>全部 Agent</strong>
                <span>{{ agents.length }} 个成员</span>
              </header>
              <article v-for="(agent, index) in displayAgents" :key="agent.agentId">
                <AgentPortrait :tone="(index % 5) + 1" :label="agent.name" size="sm" />
                <div>
                  <strong>{{ agent.name }}</strong>
                  <p>{{ agent.role }}</p>
                </div>
                <span :class="['agent-status', agent.status]">{{ statusLabel(agent.status) }}</span>
              </article>
            </section>
          </div>
          <span v-if="currentMode !== 'chat'" class="project-chip">会话：{{ workspaceLabel }}</span>
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
          v-else-if="currentMode === 'workflow'"
          :events="events"
          :tasks="tasks"
          :agents="agents"
          :active-confirmation="activeConfirmation"
          :status="derivedStatus"
          :session-title="workspaceLabel"
        />
        <DebugRuntimeView
          v-else
          :session-id="currentSessionId"
          :events="events"
        />
      </div>
    </section>

    <CollaborationLogPanel
      v-if="activeSection === 'session' && (currentMode === 'collaboration_graph' || currentMode === 'workflow' || currentMode === 'debug')"
      :events="events"
      :agents="agents"
      :title="currentMode === 'workflow' ? '对话 / 任务日志（实时）' : currentMode === 'debug' ? '调试事件流' : '对话 / 消息日志'"
    />
    <aside v-else-if="activeSection === 'session'" class="agent-panel">
      <header class="panel-header">
        <span>任务与状态</span>
        <span class="connection-pill" :class="{ online: eventStore.sseConnected }">{{ eventStore.sseConnected ? '实时连接' : '离线' }}</span>
      </header>

      <ConfirmationCard
        v-if="activeConfirmation"
        :confirmation="activeConfirmation"
        compact
        @resolve="resolveConfirmation"
      />

      <section class="panel-section agent-list-section">
        <header>
          <h2>Agent 列表</h2>
          <span class="agent-list-count">{{ agents.length }} 个成员</span>
        </header>
        <p v-if="!displayAgents.length" class="empty-state">暂无参与 Agent。</p>
        <article v-for="(agent, index) in displayAgents" :key="agent.agentId" class="agent-card">
          <AgentPortrait :tone="(index % 5) + 1" :label="agent.name" size="md" />
          <div class="agent-card__body">
            <div class="agent-card__top">
              <div>
                <h3>{{ agent.name }}</h3>
                <p>{{ agent.role }}</p>
              </div>
              <span class="agent-status" :class="agent.status">{{ statusLabel(agent.status) }}</span>
            </div>
            <p v-if="agent.currentTaskTitle" class="agent-task">{{ agent.currentTaskTitle }}</p>
            <p v-if="agent.thoughtSummary" class="agent-summary">{{ agent.thoughtSummary }}</p>
            <p v-if="agent.actionSummary" class="agent-summary muted">{{ agent.actionSummary }}</p>
            <div class="agent-meter">
              <span :style="{ width: agent.status === 'running' ? '66%' : agent.status === 'completed' ? '100%' : '18%' }"></span>
            </div>
            <div v-if="configuredAgentCard(agent.agentId)?.tags?.length" class="tag-row">
              <span v-for="tag in configuredAgentCard(agent.agentId)?.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
            <div v-if="agentCapabilityNames(agent).length" class="tag-row">
              <span v-for="capability in agentCapabilityNames(agent)" :key="capability" class="tag">{{ capability }}</span>
            </div>
            <p v-if="configuredAgentCard(agent.agentId)?.modelId" class="agent-model">
              模型: {{ getModelName(configuredAgentCard(agent.agentId)?.modelId) }}
            </p>
          </div>
        </article>
      </section>

      <section class="panel-section task-steps-panel">
        <header>
          <h2>任务执行步骤</h2>
          <button type="button" @click="tasksExpanded = !tasksExpanded">
            {{ tasksExpanded ? '收起全部' : '展开全部' }}
          </button>
        </header>
        <p v-if="!tasks.length" class="empty-state">暂无任务。</p>
        <article v-for="(task, index) in tasks" :key="task.taskId" class="task-step">
          <span :class="['task-step__index', task.status]">{{ index + 1 }}</span>
          <div>
            <strong>{{ task.title }}</strong>
            <p v-if="tasksExpanded">{{ task.resultSummary ?? statusLabel(task.status) }}</p>
            <ul v-if="tasksExpanded && task.acceptanceCriteria.length" class="task-criteria">
              <li v-for="item in task.acceptanceCriteria" :key="item">{{ item }}</li>
            </ul>
          </div>
          <small>{{ statusLabel(task.status) }}</small>
        </article>
      </section>
    </aside>

    <section v-else-if="activeSection === 'knowledge'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>知识库</h1>
          <p>查看当前后端返回的真实知识库，供 Agent 任务检索使用。</p>
        </div>
        <span class="admin-count">{{ knowledgeStore.knowledgeBases.length }} 个知识库</span>
      </header>
      <div class="admin-grid">
        <article v-for="base in knowledgeStore.knowledgeBases" :key="base.id" class="admin-card">
          <header>
            <strong>{{ base.name }}</strong>
            <span>{{ base.scope }}</span>
          </header>
          <p>{{ base.description ?? '暂无描述' }}</p>
          <dl>
            <div>
              <dt>Embedding 模型</dt>
              <dd>{{ base.embeddingModel }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ base.updatedAt }}</dd>
            </div>
          </dl>
        </article>
        <p v-if="!knowledgeStore.knowledgeBases.length" class="admin-empty">暂无知识库数据。</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'settings'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>设置</h1>
          <p>当前工作区运行状态与会话默认参数。</p>
        </div>
      </header>
      <div class="admin-grid compact">
        <article class="admin-card">
          <strong>会话默认配置</strong>
          <dl>
            <div>
              <dt>默认 token 预算</dt>
              <dd>30000</dd>
            </div>
            <div>
              <dt>当前会话</dt>
              <dd>{{ workspaceLabel }}</dd>
            </div>
          </dl>
        </article>
        <article class="admin-card">
          <strong>连接状态</strong>
          <dl>
            <div>
              <dt>SSE</dt>
              <dd>{{ eventStore.sseConnected ? '实时连接' : '未连接' }}</dd>
            </div>
            <div>
              <dt>已加载事件</dt>
              <dd>{{ events.length }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>

    <section v-else-if="activeSection === 'agents'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>Agent 管理</h1>
          <p>查看并管理 Agent 的运行时类型与能力配置，可直接新增或删除 Agent。</p>
        </div>
        <div class="admin-header-actions">
          <span class="admin-count">{{ agentStore.agents.length }} 个 Agent</span>
          <button class="panel-action-button primary" type="button" @click="toggleModelAgentForm">
            <UiIcon name="plus" :size="15" />
            添加 Agent
          </button>
        </div>
      </header>

      <form v-if="showModelAgentForm" class="agent-create-form admin-agent-form" @submit.prevent="submitModelAgentForm">
        <label>
          <span>名称</span>
          <input v-model="modelAgentName" type="text" placeholder="Research Agent" />
        </label>
        <label>
          <span>标签</span>
          <input v-model="modelAgentTags" type="text" placeholder="research, market" />
        </label>
        <label>
          <span>能力描述</span>
          <textarea v-model="modelAgentRole" rows="3" placeholder="说明这个 Agent 负责什么，以及适合处理哪些任务" />
        </label>
        <label>
          <span>模型</span>
          <select v-model="modelAgentModelId">
            <option value="">默认模型</option>
            <option v-for="model in modelStore.models" :key="model.id" :value="model.id">
              {{ model.name }}
            </option>
          </select>
        </label>
        <div class="agent-capability-picker">
          <span>可用能力</span>
          <button
            v-for="capability in agentStore.capabilities"
            :key="capability.id"
            type="button"
            :class="{ selected: modelAgentCapabilityIds.includes(capability.id) }"
            @click="toggleModelAgentCapability(capability.id)"
          >
            {{ capability.name }}
          </button>
        </div>
        <p v-if="modelAgentError" class="form-error">{{ modelAgentError }}</p>
        <div class="form-actions">
          <button type="button" @click="toggleModelAgentForm">取消</button>
          <button type="submit" class="primary" :disabled="isSavingModelAgent">
            {{ isSavingModelAgent ? '创建中' : '创建 Agent' }}
          </button>
        </div>
      </form>

      <div class="admin-grid">
        <article v-for="agent in agentStore.agents" :key="agent.id" class="admin-card">
          <header>
            <strong>{{ agent.name }}</strong>
            <span>{{ agent.runtimeType }}</span>
          </header>
          <p>{{ agent.role }}</p>
          <div v-if="agent.capabilityIds.length" class="tag-row">
            <span v-for="capabilityId in agent.capabilityIds" :key="capabilityId" class="tag">
              {{ agentStore.capabilityName(capabilityId) }}
            </span>
          </div>
          <dl v-if="agent.modelId">
            <div>
              <dt>模型</dt>
              <dd>{{ getModelName(agent.modelId) }}</dd>
            </div>
          </dl>
          <footer class="admin-card-actions">
            <button class="panel-action-button danger" type="button" @click="removeAgentFromAdmin(agent.id, agent.name)">
              <UiIcon name="trash" :size="14" />
              删除
            </button>
          </footer>
        </article>
        <p v-if="!agentStore.agents.length" class="admin-empty">暂无 Agent，点击右上角"添加 Agent"创建。</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'models'" class="workspace-admin">
      <ModelManagementPanel />
    </section>

    <section v-else-if="activeSection === 'tools'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>工具集成</h1>
          <p>查看后端能力注册表，创建 Agent 时可选择这些能力。</p>
        </div>
        <span class="admin-count">{{ agentStore.capabilities.length }} 个能力</span>
      </header>
      <div class="admin-grid">
        <article v-for="capability in agentStore.capabilities" :key="capability.id" class="admin-card">
          <header>
            <strong>{{ capability.name }}</strong>
            <span>{{ capability.riskLevel }}</span>
          </header>
          <p>{{ capability.description }}</p>
          <dl>
            <div>
              <dt>能力标识</dt>
              <dd>{{ capability.key }}</dd>
            </div>
            <div>
              <dt>风险等级</dt>
              <dd>{{ capability.riskLevel }}</dd>
            </div>
          </dl>
        </article>
        <p v-if="!agentStore.capabilities.length" class="admin-empty">暂无能力数据。</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'notifications'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>通知中心</h1>
          <p>展示当前会话中需要关注的确认、状态和错误事件。</p>
        </div>
        <span class="admin-count">{{ events.length }} 条事件</span>
      </header>
      <div class="admin-list">
        <article
          v-for="event in events.filter((item) => item.priority === 'high' || item.type === 'user_confirmation_requested' || item.type === 'error_reported')"
          :key="event.id"
          class="admin-list-item"
        >
          <strong>{{ event.type }}</strong>
          <p>{{ event.content }}</p>
          <small>{{ event.createdAt }}</small>
        </article>
        <p
          v-if="!events.filter((item) => item.priority === 'high' || item.type === 'user_confirmation_requested' || item.type === 'error_reported').length"
          class="admin-empty"
        >
          暂无需要处理的通知。
        </p>
      </div>
    </section>

    <section v-if="showCreateSessionDialog" class="modal-backdrop" aria-label="新建会话">
      <form class="modal-panel session-create-dialog" @submit.prevent="createSessionFromDialog">
        <header>
          <div>
            <h2>新建会话</h2>
            <p>选择真实 Agent，并输入本次协作任务。</p>
          </div>
          <button type="button" class="modal-close-button" @click="showCreateSessionDialog = false">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>任务</span>
          <textarea v-model="newSessionInput" rows="4" placeholder="描述要让 Agent 协作完成的目标" />
        </label>
        <div class="dialog-agent-picker">
          <span>参与 Agent</span>
          <p v-if="!agentStore.agents.length" class="empty-state">暂无 Agent，请先在右侧添加 Agent。</p>
          <button
            v-for="agent in agentStore.agents"
            :key="agent.id"
            type="button"
            :class="{ selected: selectedSessionAgentIds.includes(agent.id) }"
            @click="toggleSessionAgent(agent.id)"
          >
            <strong>{{ agent.name }}</strong>
            <small>{{ agent.role }}</small>
          </button>
        </div>
        <p v-if="sessionCreateError" class="form-error">{{ sessionCreateError }}</p>
        <footer class="form-actions">
          <button type="button" @click="showCreateSessionDialog = false">取消</button>
          <button type="submit" class="primary" :disabled="isCreatingSession">
            {{ isCreatingSession ? '创建中' : '创建会话' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
