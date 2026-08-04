<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  CircleCheck,
  Connection,
  CopyDocument,
  FolderAdd,
  Monitor,
  Refresh,
  VideoPlay,
  WarningFilled
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { apiBaseUrl } from '@/config/runtime'
import { useLocalRuntimeStore } from '@/stores/localRuntime'
import {
  createLocalRuntimeLaunchUrl,
  requestLocalRuntimeLaunch,
  resolveLocalRuntimeServerUrl
} from '@/utils/localRuntimeLauncher'

const router = useRouter()
const localRuntimeStore = useLocalRuntimeStore()
const refreshing = ref(false)
const waking = ref(false)
const pageError = ref('')
let disposed = false

const connectedDevices = computed(() => localRuntimeStore.devices.filter((device) => device.connected))
const isConnected = computed(() => connectedDevices.value.length > 0)
const serverUrl = computed(() => resolveLocalRuntimeServerUrl(apiBaseUrl, window.location.origin))
const launchUrl = computed(() => createLocalRuntimeLaunchUrl(serverUrl.value))
const installCommand = computed(() => `agent-runtime install --server ${serverUrl.value}`)

function runtimeLabels(runtimes: Readonly<Record<string, string | undefined>>) {
  return Object.keys(runtimes).filter((runtime) => runtimes[runtime]).join('、') || '未探测到 Runtime'
}

function formatTime(value?: string) {
  if (!value) return '尚未连接'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

async function refreshStatus(silent = false) {
  if (!silent) refreshing.value = true
  pageError.value = ''
  const results = await Promise.allSettled([
    localRuntimeStore.loadDevices(),
    localRuntimeStore.loadWorkspaces()
  ])
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) {
    pageError.value = rejected.reason instanceof Error ? rejected.reason.message : '读取本地运行状态失败'
  }
  if (!silent) refreshing.value = false
  return isConnected.value
}

async function wakeLocalRuntime() {
  pageError.value = ''
  waking.value = true
  requestLocalRuntimeLaunch(launchUrl.value)

  for (let attempt = 0; attempt < 16 && !disposed; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_000))
    if (await refreshStatus(true)) {
      waking.value = false
      ElMessage.success('本地助手已连接')
      return
    }
  }

  if (!disposed) {
    waking.value = false
    pageError.value = '未检测到本地助手。请确认已安装并注册唤醒协议，然后重试。'
  }
}

async function authorizeWorkspace() {
  pageError.value = ''
  try {
    await localRuntimeStore.authorizeWorkspace()
    ElMessage.success('本机工作区已连接')
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '连接本机工作区失败'
  }
}

async function copyInstallCommand() {
  await navigator.clipboard.writeText(installCommand.value)
  ElMessage.success('安装命令已复制')
}

onMounted(() => {
  void refreshStatus()
})

onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <main class="local-runtime-page">
    <header class="local-runtime-page__header">
      <div>
        <p class="local-runtime-page__eyebrow">Runtime</p>
        <h1>本地运行</h1>
      </div>
      <el-button :icon="Refresh" :loading="refreshing" @click="refreshStatus()">刷新</el-button>
    </header>

    <section class="runtime-status-band" aria-live="polite">
      <div class="runtime-status-band__state">
        <el-icon :class="isConnected ? 'is-online' : 'is-offline'" :size="26">
          <CircleCheck v-if="isConnected" />
          <WarningFilled v-else />
        </el-icon>
        <div>
          <strong>{{ isConnected ? '本地助手在线' : '本地助手离线' }}</strong>
          <span>{{ isConnected ? `${connectedDevices.length} 台设备已连接` : '等待本机 Runtime 连接' }}</span>
        </div>
      </div>
      <dl>
        <div>
          <dt>设备</dt>
          <dd>{{ localRuntimeStore.devices.length }}</dd>
        </div>
        <div>
          <dt>在线</dt>
          <dd>{{ connectedDevices.length }}</dd>
        </div>
        <div>
          <dt>工作区</dt>
          <dd>{{ localRuntimeStore.workspaces.length }}</dd>
        </div>
      </dl>
      <div class="runtime-status-band__actions">
        <el-button
          v-if="!isConnected"
          type="primary"
          :icon="VideoPlay"
          :loading="waking"
          @click="wakeLocalRuntime"
        >
          {{ waking ? '等待连接' : '启动本地助手' }}
        </el-button>
        <el-button
          v-else
          type="primary"
          :icon="FolderAdd"
          :loading="localRuntimeStore.authorizing"
          @click="authorizeWorkspace"
        >
          连接本机目录
        </el-button>
      </div>
    </section>

    <p v-if="pageError" class="runtime-page-error" role="alert">{{ pageError }}</p>

    <div class="local-runtime-page__content">
      <section class="runtime-section" aria-labelledby="runtime-devices-title">
        <header>
          <div>
            <h2 id="runtime-devices-title">设备</h2>
            <span>{{ localRuntimeStore.devices.length }} 台</span>
          </div>
          <el-button text :icon="Connection" @click="router.push('/local-runtime/activate')">绑定设备</el-button>
        </header>

        <div v-if="localRuntimeStore.devices.length" class="runtime-device-list">
          <article v-for="device in localRuntimeStore.devices" :key="device.deviceId" class="runtime-device-item">
            <el-icon :size="22"><Monitor /></el-icon>
            <div class="runtime-device-item__main">
              <strong>{{ device.displayName }}</strong>
              <span>{{ runtimeLabels(device.runtimes) }}</span>
            </div>
            <div class="runtime-device-item__meta">
              <el-tag :type="device.connected ? 'success' : 'info'" effect="plain">
                {{ device.connected ? '在线' : '离线' }}
              </el-tag>
              <span>CLI {{ device.cliVersion }}</span>
              <span>{{ formatTime(device.lastSeenAt) }}</span>
            </div>
          </article>
        </div>

        <el-empty v-else :image-size="76" description="暂无已绑定设备" />
      </section>

      <section class="runtime-section" aria-labelledby="runtime-workspaces-title">
        <header>
          <div>
            <h2 id="runtime-workspaces-title">本机工作区</h2>
            <span>{{ localRuntimeStore.workspaces.length }} 个</span>
          </div>
          <el-button
            text
            :icon="FolderAdd"
            :disabled="!isConnected"
            :loading="localRuntimeStore.authorizing"
            @click="authorizeWorkspace"
          >
            添加目录
          </el-button>
        </header>

        <div v-if="localRuntimeStore.workspaces.length" class="runtime-workspace-list">
          <article
            v-for="workspace in localRuntimeStore.workspaces"
            :key="workspace.workspaceId"
            class="runtime-workspace-item"
          >
            <div>
              <strong>{{ workspace.displayName }}</strong>
              <span>{{ workspace.runtimeTypes.join('、') || '无可用 Runtime' }}</span>
            </div>
            <el-tag type="success" effect="plain">已连接</el-tag>
          </article>
        </div>

        <el-empty v-else :image-size="76" description="暂无在线工作区" />
      </section>
    </div>

    <section v-if="!isConnected" class="runtime-install-band">
      <div>
        <h2>本地助手注册</h2>
        <code>{{ installCommand }}</code>
      </div>
      <el-tooltip content="复制安装命令" placement="top">
        <el-button :icon="CopyDocument" aria-label="复制安装命令" @click="copyInstallCommand" />
      </el-tooltip>
    </section>
  </main>
</template>

<style scoped>
.local-runtime-page {
  height: 100%;
  overflow-y: auto;
  background: var(--el-bg-color-page, #f5f7fa);
  color: var(--el-text-color-primary, #303133);
}

.local-runtime-page__header,
.runtime-status-band,
.local-runtime-page__content,
.runtime-install-band {
  width: min(1120px, calc(100% - 48px));
  margin: 0 auto;
}

.local-runtime-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 96px;
}

.local-runtime-page__eyebrow {
  margin: 0 0 4px;
  color: var(--el-color-primary, #409eff);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.local-runtime-page h1,
.local-runtime-page h2,
.local-runtime-page p {
  letter-spacing: 0;
}

.local-runtime-page h1 {
  margin: 0;
  font-size: 24px;
}

.runtime-status-band {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  align-items: center;
  gap: 28px;
  padding: 22px 0;
  border-top: 1px solid var(--el-border-color, #dcdfe6);
  border-bottom: 1px solid var(--el-border-color, #dcdfe6);
}

.runtime-status-band__state {
  display: flex;
  align-items: center;
  gap: 12px;
}

.runtime-status-band__state .is-online {
  color: var(--el-color-success, #67c23a);
}

.runtime-status-band__state .is-offline {
  color: var(--el-color-warning, #e6a23c);
}

.runtime-status-band__state div {
  display: grid;
  gap: 4px;
}

.runtime-status-band__state span,
.runtime-device-item span,
.runtime-workspace-item span,
.runtime-section header span {
  color: var(--el-text-color-secondary, #606266);
  font-size: 13px;
}

.runtime-status-band dl {
  display: grid;
  grid-template-columns: repeat(3, 72px);
  margin: 0;
}

.runtime-status-band dl div {
  display: grid;
  gap: 3px;
  border-left: 1px solid var(--el-border-color-lighter, #ebeef5);
  text-align: center;
}

.runtime-status-band dt {
  color: var(--el-text-color-secondary, #606266);
  font-size: 12px;
}

.runtime-status-band dd {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
}

.runtime-page-error {
  width: min(1120px, calc(100% - 48px));
  margin: 16px auto 0;
  padding: 10px 12px;
  border-left: 3px solid var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef0f0);
  color: var(--el-color-danger-dark-2, #c45656);
  font-size: 13px;
}

.local-runtime-page__content {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
  gap: 32px;
  padding: 30px 0;
}

.runtime-section > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.runtime-section > header div {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.runtime-section h2,
.runtime-install-band h2 {
  margin: 0;
  font-size: 16px;
}

.runtime-device-list,
.runtime-workspace-list {
  display: grid;
  gap: 8px;
  padding-top: 12px;
}

.runtime-device-item,
.runtime-workspace-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 66px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 6px;
  background: var(--el-bg-color, #fff);
}

.runtime-device-item > .el-icon {
  color: var(--el-color-primary, #409eff);
}

.runtime-device-item__main,
.runtime-workspace-item > div {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 4px;
}

.runtime-device-item__main strong,
.runtime-workspace-item strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-device-item__meta {
  display: grid;
  justify-items: end;
  gap: 3px;
  min-width: 142px;
}

.runtime-install-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 0 32px;
  border-top: 1px solid var(--el-border-color, #dcdfe6);
}

.runtime-install-band > div {
  display: grid;
  min-width: 0;
  gap: 8px;
}

.runtime-install-band code {
  overflow: hidden;
  color: var(--el-text-color-regular, #606266);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .runtime-status-band {
    grid-template-columns: 1fr auto;
  }

  .runtime-status-band dl {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .local-runtime-page__content {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .local-runtime-page__header,
  .runtime-status-band,
  .local-runtime-page__content,
  .runtime-install-band,
  .runtime-page-error {
    width: min(100% - 28px, 1120px);
  }

  .runtime-status-band {
    grid-template-columns: 1fr;
    gap: 18px;
  }

  .runtime-status-band dl {
    grid-column: auto;
    grid-row: auto;
    grid-template-columns: repeat(3, 1fr);
  }

  .runtime-status-band__actions .el-button {
    width: 100%;
  }

  .runtime-device-item {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .runtime-device-item__meta {
    width: 100%;
    min-width: 0;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    justify-items: start;
  }
}
</style>
