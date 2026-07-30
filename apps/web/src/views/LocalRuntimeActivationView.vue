<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CircleCheck, Connection } from '@element-plus/icons-vue'
import {
  readLocalRuntimeAdminToken,
  useLocalRuntimeStore
} from '@/stores/localRuntime'

const route = useRoute()
const router = useRouter()
const localRuntimeStore = useLocalRuntimeStore()
const userCode = ref('')
const adminToken = ref(readLocalRuntimeAdminToken())
const submitting = ref(false)
const approvedDeviceName = ref('')
const error = ref('')

const normalizedCode = computed(() => userCode.value.trim().toUpperCase())

onMounted(() => {
  if (typeof route.query.code === 'string') userCode.value = route.query.code
})

async function approve() {
  if (!normalizedCode.value) {
    error.value = '请输入 CLI 显示的设备码'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    const device = await localRuntimeStore.approveDevice(normalizedCode.value, adminToken.value)
    approvedDeviceName.value = device.displayName
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '设备授权失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="local-runtime-activation">
    <div class="activation-panel">
      <header>
        <el-icon :size="28"><Connection /></el-icon>
        <div>
          <h1>连接本机 Runtime</h1>
          <p>确认当前终端中 agent-runtime login 显示的设备码。</p>
        </div>
      </header>

      <el-result
        v-if="approvedDeviceName"
        icon="success"
        title="设备已授权"
        :sub-title="`${approvedDeviceName} 可以完成登录并连接工作区。`"
      >
        <template #extra>
          <el-button type="primary" @click="router.push('/workspace')">返回工作台</el-button>
        </template>
      </el-result>

      <el-form v-else label-position="top" @submit.prevent="approve">
        <el-form-item label="管理员令牌">
          <el-input
            v-model="adminToken"
            size="large"
            type="password"
            autocomplete="current-password"
            show-password
            placeholder="LOCAL_RUNTIME_ADMIN_TOKEN"
            @input="error = ''"
          />
        </el-form-item>
        <el-form-item label="设备码" :error="error">
          <el-input
            v-model="userCode"
            size="large"
            maxlength="9"
            autocomplete="one-time-code"
            placeholder="ABCD-EFGH"
            @input="error = ''"
          />
        </el-form-item>
        <el-button
          class="activation-submit"
          type="primary"
          size="large"
          native-type="submit"
          :loading="submitting"
          :icon="CircleCheck"
        >
          授权此设备
        </el-button>
      </el-form>
    </div>
  </section>
</template>

<style scoped>
.local-runtime-activation {
  display: grid;
  place-items: center;
  min-height: 100%;
  padding: 24px;
  background: var(--el-bg-color-page, #f5f7fa);
}

.activation-panel {
  width: min(520px, 100%);
  padding: 28px;
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  border-radius: 8px;
  background: var(--el-bg-color, #fff);
  box-shadow: var(--el-box-shadow-light);
}

.activation-panel > header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 28px;
  color: var(--el-color-primary, #409eff);
}

.activation-panel h1 {
  margin: 0;
  color: var(--el-text-color-primary, #303133);
  font-size: 22px;
  letter-spacing: 0;
}

.activation-panel p {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary, #909399);
  font-size: 14px;
}

.activation-submit {
  width: 100%;
}
</style>
