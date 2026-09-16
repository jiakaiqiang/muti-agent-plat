<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { DesktopStatus } from '../../../desktop/src/contracts'

const bridge = window.agentClusterDesktop
const status = ref<DesktopStatus>()
const address = ref('')
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
const runtimeLabels = { stopped: '未启动', starting: '正在启动', authorizing: '等待设备授权', connecting: '正在连接平台', connected: '已连接', error: '连接失败' }
const updateLabels = { unconfigured: '此版本尚未配置更新源', idle: '当前没有待安装更新', checking: '正在检查更新', available: '发现新版本', downloading: '正在下载', downloaded: '更新已下载，任务结束后可重启安装', error: '更新失败' }
async function refresh() { if (bridge) status.value = await bridge.status() }
function changeNotifications(value: string | number | boolean) { void perform(() => bridge!.setNotificationsEnabled(Boolean(value))) }
async function perform(action: () => Promise<unknown>) {
  busy.value = true; error.value = ''
  try { await action(); await refresh() }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
  finally { busy.value = false }
}
onMounted(async () => {
  await perform(async () => { await refresh(); address.value = status.value?.serverUrl || 'http://127.0.0.1:8099' })
  timer = setInterval(() => { void refresh().catch(() => undefined) }, 1500)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="desktop-connection">
    <header><h1>连接与更新</h1><p>Agent Cluster {{ status?.version }} · 桌面应用</p></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-empty v-if="!bridge" description="此页面仅在桌面应用中可用。" />
    <template v-else>
      <el-form label-position="top" @submit.prevent="perform(() => bridge!.configure(address))">
        <el-form-item label="平台地址"><el-input v-model="address" placeholder="https://你的平台地址" :disabled="busy" /></el-form-item>
        <p class="hint">远程平台使用 HTTPS。本地开发可连接 http://127.0.0.1:8099；应用不会自动启动平台服务。</p>
        <el-button type="primary" native-type="submit" :loading="busy">连接并保存</el-button>
        <el-button v-if="status?.serverUrl" @click="$router.push('/workspace')">进入工作台</el-button>
      </el-form>
      <section v-if="status?.serverUrl" aria-label="本地助手">
        <h2>本地助手</h2>
        <p>{{ runtimeLabels[status.runtime.state] }}<span v-if="status.runtime.busy"> · 正在处理本地任务或请求</span></p>
        <el-alert v-if="status.runtime.error" :title="status.runtime.error" type="error" :closable="false" />
        <div v-if="status.runtime.userCode" class="authorization">
          <p>设备码：<strong>{{ status.runtime.userCode }}</strong></p>
          <el-button type="primary" @click="$router.push({ path: '/local-runtime/activate', query: { code: status.runtime.userCode } })">授权此设备</el-button>
          <p class="hint">沿用平台的设备授权方式；需要管理员提供本地运行管理凭据。</p>
        </div>
        <el-button :disabled="busy || !['stopped', 'error'].includes(status.runtime.state)" @click="perform(() => bridge!.startRuntime())">启动本地助手</el-button>
        <el-button :disabled="busy || status.runtime.state === 'stopped'" @click="perform(() => bridge!.stopRuntime())">停止助手</el-button>
        <el-button :disabled="status.runtime.state !== 'connected'" @click="$router.push('/local-runtime')">管理本机目录与 Agent</el-button>
        <p class="hint">关闭窗口后助手继续运行。需要退出时使用“应用 → 退出应用”；执行期间会阻止退出。</p>
      </section>
      <section v-if="status?.notifications" aria-label="消息通知">
        <h2>消息通知</h2>
        <el-switch :model-value="status.notifications.enabled" :disabled="busy || !status.notifications.supported"
          active-text="任务完成通知" aria-label="任务完成通知"
          @change="changeNotifications" />
        <p class="hint">会话任务完成时显示系统通知，点击即可查看对应会话。窗口最小化或隐藏到托盘后仍会提醒。</p>
        <p v-if="!status.notifications.supported" class="hint">当前系统不支持桌面通知。</p>
        <el-alert v-if="status.notifications.error" :title="status.notifications.error" type="error" :closable="false" />
        <el-button :disabled="busy || !status.notifications.enabled || !status.notifications.supported"
          @click="perform(() => bridge!.testNotification())">发送测试通知</el-button>
        <p class="hint">通知位置和显示时长由系统控制。若未弹出，请检查 Windows 通知设置与勿扰模式。</p>
      </section>
      <section v-if="status" aria-label="应用更新">
        <h2>应用更新</h2><p>{{ updateLabels[status.update.state] }} <span v-if="status.update.version">{{ status.update.version }}</span></p>
        <el-progress v-if="status.update.state === 'downloading'" :percentage="Math.round(status.update.percent || 0)" />
        <el-alert v-if="status.update.error" :title="status.update.error" type="error" :closable="false" />
        <el-button :disabled="busy || ['unconfigured', 'checking', 'downloading', 'downloaded'].includes(status.update.state)" @click="perform(() => bridge!.checkUpdate())">检查更新</el-button>
        <el-button v-if="status.update.state === 'available'" :disabled="busy" @click="perform(() => bridge!.downloadUpdate())">下载更新</el-button>
        <el-button v-if="status.update.state === 'downloaded'" type="primary" :disabled="busy" @click="perform(() => bridge!.installUpdate())">重启并安装更新</el-button>
      </section>
    </template>
  </section>
</template>

<style scoped>
.desktop-connection { max-width: 800px; margin: 0 auto; padding: 24px; height: 100%; overflow: auto; color: var(--el-text-color-primary); }
header, form, section > section { margin-bottom: 24px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 0 0 12px; }
section > section { border-top: 1px solid var(--el-border-color-light); padding-top: 24px; }
p { line-height: 1.6; }
.hint, header p { color: var(--el-text-color-regular); font-size: 13px; }
.el-alert, .el-progress, .authorization { margin-bottom: 16px; }
</style>
