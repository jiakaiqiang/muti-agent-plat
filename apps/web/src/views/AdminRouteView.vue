<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import { useSessionStore } from '@/stores/session'
import { apiBaseUrl, runtimeModeLabel } from '@/config/runtime'
import AgentManager from '@/components/AgentManager.vue'
import RuntimeModelManager from '@/components/RuntimeModelManager.vue'
import RuntimeVersionSummary from '@/components/RuntimeVersionSummary.vue'
import SkillManager from '@/components/SkillManager.vue'
import WorkflowManager from '@/components/WorkflowManager.vue'

type AdminSection = 'workflows' | 'agents' | 'skills' | 'knowledge' | 'settings' | 'models' | 'tools' | 'notifications'

const props = defineProps<{ section: AdminSection }>()

const agentStore = useAgentStore()
const eventStore = useEventStore()
const knowledgeStore = useKnowledgeStore()
const runtimeModelStore = useRuntimeModelStore()
const sessionStore = useSessionStore()

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const events = computed(() => eventStore.eventsForSession(currentSessionId.value))
const notificationEvents = computed(() =>
  events.value.filter(
    (item) =>
      item.priority === 'high' ||
      item.type === 'user_confirmation_requested' ||
      item.type === 'error_reported'
  )
)

onMounted(async () => {
  await Promise.allSettled([
    agentStore.agentsBySurface.management?.length ? Promise.resolve() : agentStore.loadAgents(),
    agentStore.capabilities.length ? Promise.resolve() : agentStore.loadCapabilities(),
    knowledgeStore.knowledgeBases.length ? Promise.resolve() : knowledgeStore.loadKnowledgeBases(),
    runtimeModelStore.availability.length ? Promise.resolve() : runtimeModelStore.loadAvailability(),
    sessionStore.sessions.length ? Promise.resolve() : sessionStore.loadSessions()
  ])

  if (!sessionStore.currentSession && sessionStore.sessions.length) {
    await sessionStore.loadSession().catch(() => undefined)
  }
  if (sessionStore.currentSession && !events.value.length) {
    await eventStore.loadEvents(sessionStore.currentSession.id).catch(() => undefined)
  }
})

function riskTagType(riskLevel: string) {
  if (riskLevel === 'high') return 'danger'
  if (riskLevel === 'medium') return 'warning'
  return 'info'
}
</script>

<template>
  <section :class="['workspace-admin', `${section}-admin-page`]">
    <AgentManager
      v-if="section === 'agents'"
      :agents="agentStore.agents"
      :capabilities="agentStore.capabilities"
    />

    <WorkflowManager v-else-if="section === 'workflows'" />

    <template v-else-if="section === 'skills'">
      <header class="admin-header">
        <div>
          <h1>Skill 管理</h1>
          <p>管理可复用工作规则，以及 Agent Profile 中的 Skill 引用。</p>
        </div>
      </header>
      <SkillManager />
    </template>

    <template v-else-if="section === 'knowledge'">
      <header class="admin-header">
        <div>
          <h1>知识库</h1>
          <p>查看当前后端返回的知识库，供 Agent 在任务中检索使用。</p>
        </div>
        <el-tag type="info">{{ knowledgeStore.knowledgeBases.length }} 个知识库</el-tag>
      </header>
      <div v-if="knowledgeStore.knowledgeBases.length" class="admin-grid">
        <el-card v-for="base in knowledgeStore.knowledgeBases" :key="base.id" shadow="never">
          <template #header>
            <div class="route-card-header">
              <strong>{{ base.name }}</strong>
              <el-tag size="small">{{ base.scope }}</el-tag>
            </div>
          </template>
          <p>{{ base.description ?? '暂无描述' }}</p>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="Embedding 模型">{{ base.embeddingModel }}</el-descriptions-item>
            <el-descriptions-item label="更新时间">{{ base.updatedAt }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>
      <el-empty v-else description="暂无知识库数据" />
    </template>

    <template v-else-if="section === 'settings'">
      <header class="admin-header">
        <div>
          <h1>设置</h1>
          <p>查看工作台运行状态与会话默认参数。</p>
        </div>
      </header>
      <div class="admin-grid compact">
        <el-card shadow="never" header="会话默认配置">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="默认 Token 预算">30000</el-descriptions-item>
            <el-descriptions-item label="当前会话">
              {{ sessionStore.currentSession?.title ?? '无活动会话' }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
        <el-card shadow="never" header="连接状态">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="SSE">
              <el-tag :type="eventStore.sseConnected ? 'success' : 'info'">
                {{ eventStore.sseConnected ? '实时连接' : '未连接' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="已加载事件">{{ events.length }}</el-descriptions-item>
            <el-descriptions-item label="运行模式">{{ runtimeModeLabel }}</el-descriptions-item>
            <el-descriptions-item label="后端地址">{{ apiBaseUrl }}</el-descriptions-item>
          </el-descriptions>
          <dl class="runtime-version-summary">
            <RuntimeVersionSummary />
          </dl>
        </el-card>
      </div>
    </template>

    <template v-else-if="section === 'models'">
      <header class="admin-header">
        <div>
          <h1>模型管理</h1>
          <p>管理 Generic LLM 模型以及 Agent Runtime 配置。</p>
        </div>
        <el-tag type="info">{{ agentStore.agents.length }} 个 Agent</el-tag>
      </header>
      <RuntimeModelManager />
    </template>

    <template v-else-if="section === 'tools'">
      <header class="admin-header">
        <div>
          <h1>工具集成</h1>
          <p>查看后端能力注册表以及 Agent 可绑定的能力。</p>
        </div>
        <el-tag type="info">{{ agentStore.capabilities.length }} 个能力</el-tag>
      </header>
      <div v-if="agentStore.capabilities.length" class="admin-grid">
        <el-card v-for="capability in agentStore.capabilities" :key="capability.id" shadow="never">
          <template #header>
            <div class="route-card-header">
              <strong>{{ capability.name }}</strong>
              <el-tag :type="riskTagType(capability.riskLevel)" size="small">
                {{ capability.riskLevel }}
              </el-tag>
            </div>
          </template>
          <p>{{ capability.descriptionMarkdown }}</p>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="能力标识">{{ capability.key }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>
      <el-empty v-else description="暂无能力数据" />
    </template>

    <template v-else-if="section === 'notifications'">
      <header class="admin-header">
        <div>
          <h1>通知中心</h1>
          <p>展示当前会话中需要关注的确认、状态和错误事件。</p>
        </div>
        <el-tag type="info">{{ notificationEvents.length }} 条通知</el-tag>
      </header>
      <div v-if="notificationEvents.length" class="admin-list">
        <el-alert
          v-for="event in notificationEvents"
          :key="event.id"
          :title="event.type"
          :description="typeof event.content === 'string' ? event.content : '该事件缺少可展示内容'"
          :type="event.type === 'error_reported' ? 'error' : 'warning'"
          :closable="false"
          show-icon
        />
      </div>
      <el-empty v-else description="暂无需要处理的通知" />
    </template>
  </section>
</template>

<style scoped>
.workspace-admin {
  height: 100%;
  overflow: auto;
  background: var(--el-bg-color-page, #f5f7fa);
}

.route-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.route-card-header strong {
  color: var(--el-text-color-primary, #303133);
  font-size: 15px;
}

.el-card p {
  margin: 0 0 16px;
  color: var(--el-text-color-regular, #606266);
  line-height: 1.6;
}

.admin-list {
  display: grid;
  gap: 12px;
}

.runtime-version-summary {
  display: grid;
  gap: 0;
  margin: 16px 0 0;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-bottom: 0;
}

.runtime-version-summary :deep(> div) {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  min-height: 40px;
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.runtime-version-summary :deep(dt),
.runtime-version-summary :deep(dd) {
  display: flex;
  align-items: center;
  margin: 0;
  padding: 8px 11px;
}

.runtime-version-summary :deep(dt) {
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--el-text-color-regular, #606266);
}

.runtime-version-summary :deep(dd) {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary, #303133);
}
</style>
