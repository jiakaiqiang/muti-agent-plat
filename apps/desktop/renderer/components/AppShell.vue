<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  Bell,
  ChatDotRound,
  Connection,
  Cpu,
  DataAnalysis,
  Files,
  Monitor,
  Operation,
  Setting,
  User
} from '@element-plus/icons-vue'
import { useAgentStore } from '@/stores/agent'
import { useAppUiStore } from '@/stores/appUi'

const route = useRoute()
const router = useRouter()
const unsubscribeNotification = window.agentClusterDesktop?.onOpenSession?.(sessionId => {
  void router.push({ name: 'workspace-session', params: { sessionId } })
})
onUnmounted(() => unsubscribeNotification?.())
const agentStore = useAgentStore()
const appUiStore = useAppUiStore()
const isDesktop = true
const { routeRenderError } = storeToRefs(appUiStore)

const navigation = [
  { path: '/workspace', label: '工作台', icon: ChatDotRound, section: 'session' },
  { path: '/local-runtime', label: '本地运行', icon: Monitor, section: 'local-runtime' },
  { path: '/workflows', label: '工作流管理', icon: Connection, section: 'workflows' },
  { path: '/agents', label: 'Agent 管理', icon: User, section: 'agents' },
  { path: '/skills', label: 'Skill 管理', icon: Operation, section: 'skills' },
  { path: '/knowledge', label: '知识库', icon: Files, section: 'knowledge' },
  { path: '/settings', label: '设置', icon: Setting, section: 'settings' },
  { path: '/models', label: '模型管理', icon: Cpu, section: 'models' },
  { path: '/tools', label: '工具集成', icon: DataAnalysis, section: 'tools' },
  { path: '/notifications', label: '通知中心', icon: Bell, section: 'notifications' }
] as const

const activePath = computed(() => {
  const section = String(route.meta.section ?? 'session')
  return navigation.find((item) => item.section === section)?.path ?? '/workspace'
})

const primaryAgent = computed(() => agentStore.agents[0])

watch(
  () => route.fullPath,
  () => appUiStore.clearRouteRenderError()
)

onErrorCaptured((error, _instance, info) => {
  console.error(`Route render failed at ${route.fullPath}`, error)
  appUiStore.captureRouteRenderError(error, route.fullPath, info)
  return false
})

function reloadCurrentRoute() {
  window.location.reload()
}

onMounted(() => {
  if (!agentStore.agents.length) {
    void agentStore.loadAgents().catch(() => undefined)
  }
})
</script>

<template>
  <div class="application-shell" :class="{ 'task-application': route.meta.section === 'session' }">
    <aside v-if="route.meta.section !== 'session'" class="application-rail" aria-label="主导航">
      <div class="application-brand" aria-label="Agent Cluster">
        <span></span><span></span><span></span><span></span><span></span><span></span>
      </div>

      <el-menu class="application-menu" :default-active="activePath" :collapse="true" :router="true">
        <el-menu-item
          v-for="item in navigation.filter(item => !isDesktop || item.path !== '/workflows')"
          :key="item.path"
          :index="item.path"
          :aria-label="item.label"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <template #title>{{ item.label }}</template>
        </el-menu-item>
      </el-menu>

      <el-tooltip :content="primaryAgent?.name ?? 'Agent Cluster'" placement="right">
        <div class="application-user">
          <el-avatar :size="34">{{ (primaryAgent?.name ?? 'AC').slice(0, 2) }}</el-avatar>
          <span :class="['application-user__status', primaryAgent?.status ?? 'idle']"></span>
        </div>
      </el-tooltip>
    </aside>

    <main class="application-route-view">
      <el-result
        v-if="routeRenderError"
        icon="error"
        title="页面加载失败"
        :sub-title="routeRenderError.message"
      >
        <template #extra>
          <el-button type="primary" @click="reloadCurrentRoute">重新加载页面</el-button>
        </template>
      </el-result>
      <RouterView v-else v-slot="{ Component, route: viewRoute }">
        <component :is="Component" :key="viewRoute.meta.section === 'session' ? 'task-workspace' : viewRoute.path" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.application-shell {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  width: 100%;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
  background: var(--el-bg-color-page, #f5f7fa);
}

.application-shell.task-application { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }

.application-rail {
  display: grid;
  grid-template-rows: 72px minmax(0, 1fr) 72px;
  min-height: 0;
  border-right: 1px solid var(--el-border-color-light, #e4e7ed);
  background: var(--el-bg-color, #fff);
  z-index: 30;
}

.application-brand {
  display: grid;
  grid-template-columns: repeat(3, 9px);
  place-content: center;
  gap: 4px;
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.application-brand span {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--el-color-primary, #409eff);
}

.application-brand span:nth-child(2),
.application-brand span:nth-child(5) {
  opacity: 0.65;
}

.application-brand span:nth-child(3),
.application-brand span:nth-child(4) {
  opacity: 0.35;
}

.application-menu {
  width: 100%;
  min-height: 0;
  border-right: 0;
  overflow-y: auto;
}

.application-menu.el-menu--collapse {
  width: 100%;
}

.application-menu :deep(.el-menu-item) {
  justify-content: center;
  height: 54px;
  margin: 4px 12px;
  padding: 0 !important;
  border-radius: 6px;
  color: var(--el-text-color-regular, #606266);
}

.application-menu :deep(.el-menu-item .el-icon) {
  margin: 0;
  font-size: 21px;
}

.application-menu :deep(.el-menu-item:hover) {
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
}

.application-menu :deep(.el-menu-item.is-active) {
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
}

.application-user {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
  border-top: 1px solid var(--el-border-color-lighter, #ebeef5);
  cursor: default;
}

.application-user__status {
  position: absolute;
  right: 25px;
  bottom: 17px;
  width: 9px;
  height: 9px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--el-color-info, #909399);
}

.application-user__status.active,
.application-user__status.thinking,
.application-user__status.running {
  background: var(--el-color-success, #67c23a);
}

.application-route-view {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 720px) {
  .application-shell {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) 58px;
  }

  .application-rail {
    grid-row: 2;
    grid-template: 1fr / minmax(0, 1fr);
    border-top: 1px solid var(--el-border-color-light, #e4e7ed);
    border-right: 0;
  }

  .application-brand,
  .application-user {
    display: none;
  }

  .application-menu {
    display: flex;
    overflow-x: auto;
  }

  .application-menu :deep(.el-menu-item) {
    flex: 0 0 52px;
    height: 48px;
    margin: 4px;
  }
}
</style>
