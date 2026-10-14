<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useLocalRuntimeStore } from '@/stores/localRuntime'

const store = useLocalRuntimeStore()
const { upgradeDialogOpen, upgradeInfo, upgradeProgress } = storeToRefs(store)

const busy = computed(() => ['checking', 'downloading', 'verifying', 'stopping', 'installing', 'restarting', 'reconnecting'].includes(upgradeProgress.value?.state ?? ''))
const progressPercent = computed(() => {
  const value = upgradeProgress.value?.percent
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : undefined
})
const stageLabel = computed(() => ({
  idle: '等待升级',
  checking: '正在检查升级包',
  available: '升级包可用',
  downloading: '正在下载升级包',
  verifying: '正在校验升级包',
  stopping: '正在停止旧 Runtime',
  installing: '正在安装新版本',
  restarting: '正在重新启动 Runtime',
  reconnecting: '正在重新连接服务端',
  completed: '升级完成',
  cancelled: '已取消升级',
  failed: '升级失败'
}[upgradeProgress.value?.state ?? 'idle']))
const installable = computed(() => Boolean(
  upgradeInfo.value?.releaseUrl
  && /^[a-f0-9]{64}$/i.test(upgradeInfo.value.sha256 ?? '')
  && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(upgradeInfo.value.signature ?? '')
))

function formatBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function startUpgrade() {
  try {
    await store.startUpgrade()
  } catch {
    // The store keeps the sanitized failure message in upgradeProgress.
  }
}

function cancelUpgrade() {
  store.cancelUpgrade()
}
</script>

<template>
  <el-dialog
    v-model="upgradeDialogOpen"
    title="版本升级"
    width="min(560px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    append-to-body
    aria-label="Local Runtime 版本升级"
    @close="cancelUpgrade"
  >
    <div v-if="upgradeInfo" class="runtime-upgrade-dialog" aria-live="polite">
      <div class="runtime-upgrade-dialog__versions">
        <div>
          <span>当前版本</span>
          <strong>{{ upgradeInfo.fromVersion }}</strong>
        </div>
        <span class="runtime-upgrade-dialog__arrow" aria-hidden="true">→</span>
        <div>
          <span>升级版本</span>
          <strong>{{ upgradeInfo.toVersion }}</strong>
        </div>
      </div>

      <dl class="runtime-upgrade-dialog__meta">
        <div><dt>升级对象</dt><dd>{{ upgradeInfo.subject === 'local-runtime' ? 'Local Runtime' : upgradeInfo.subject }}</dd></div>
        <div v-if="upgradeInfo.fromProtocolVersion && upgradeInfo.toProtocolVersion">
          <dt>协议版本</dt><dd>{{ upgradeInfo.fromProtocolVersion }} → {{ upgradeInfo.toProtocolVersion }}</dd>
        </div>
        <div v-if="upgradeInfo.packageSize"><dt>安装包大小</dt><dd>{{ formatBytes(upgradeInfo.packageSize) }}</dd></div>
      </dl>

      <section class="runtime-upgrade-dialog__notes" aria-labelledby="runtime-upgrade-notes-title">
        <h3 id="runtime-upgrade-notes-title">升级内容</h3>
        <ul>
          <li v-for="note in upgradeInfo.releaseNotes" :key="note">{{ note }}</li>
        </ul>
      </section>

      <el-alert
        v-if="!installable"
        title="当前环境尚未配置完整的签名升级包（地址、SHA-256 和签名均为必需），请联系管理员发布 Runtime。"
        type="warning"
        :closable="false"
        show-icon
      />
      <p class="runtime-upgrade-dialog__preserve">升级会保留设备授权、凭据和已连接的工作区。</p>

      <section class="runtime-upgrade-dialog__progress" aria-labelledby="runtime-upgrade-progress-title">
        <div class="runtime-upgrade-dialog__progress-heading">
          <h3 id="runtime-upgrade-progress-title">升级进度</h3>
          <span>{{ stageLabel }}</span>
        </div>
        <el-progress v-if="progressPercent !== undefined" :percentage="progressPercent" :status="upgradeProgress?.state === 'failed' ? 'exception' : undefined" />
        <p v-else class="runtime-upgrade-dialog__progress-text">{{ upgradeProgress?.message || '点击“立即升级”开始。' }}</p>
        <p v-if="upgradeProgress?.message && progressPercent !== undefined" class="runtime-upgrade-dialog__progress-text">{{ upgradeProgress.message }}</p>
      </section>
    </div>

    <template #footer>
      <el-button :disabled="busy" @click="cancelUpgrade">取消升级</el-button>
      <el-button type="primary" :loading="busy" :disabled="busy || !installable" @click="startUpgrade">
        {{ busy ? stageLabel : '立即升级' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.runtime-upgrade-dialog { color: var(--el-text-color-primary, #303133); }
.runtime-upgrade-dialog__versions { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; padding: 16px; border: 1px solid var(--el-border-color-lighter, #ebeef5); border-radius: 8px; background: var(--el-fill-color-lighter, #fafafa); }
.runtime-upgrade-dialog__versions div { display: grid; gap: 6px; }
.runtime-upgrade-dialog__versions span, .runtime-upgrade-dialog__meta dt { color: var(--el-text-color-secondary, #909399); font-size: 12px; }
.runtime-upgrade-dialog__versions strong { font-size: 18px; }
.runtime-upgrade-dialog__arrow { color: var(--el-color-primary, #409eff); font-size: 22px; }
.runtime-upgrade-dialog__meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.runtime-upgrade-dialog__meta div { min-width: 0; }
.runtime-upgrade-dialog__meta dd { margin: 5px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runtime-upgrade-dialog__notes { margin: 18px 0; }
.runtime-upgrade-dialog__notes h3, .runtime-upgrade-dialog__progress h3 { margin: 0; font-size: 14px; }
.runtime-upgrade-dialog__notes ul { display: grid; gap: 8px; margin: 10px 0 0; padding-left: 20px; color: var(--el-text-color-regular, #606266); font-size: 13px; line-height: 1.5; }
.runtime-upgrade-dialog__preserve, .runtime-upgrade-dialog__progress-text { margin: 12px 0 0; color: var(--el-text-color-secondary, #909399); font-size: 12px; line-height: 1.5; }
.runtime-upgrade-dialog__progress { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter, #ebeef5); }
.runtime-upgrade-dialog__progress-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.runtime-upgrade-dialog__progress-heading span { color: var(--el-color-primary, #409eff); font-size: 12px; }
@media (max-width: 520px) { .runtime-upgrade-dialog__meta { grid-template-columns: 1fr 1fr; } }
</style>
