<template>
  <div v-if="tokenInfo" class="token-indicator" :class="getStatusClass()" @click="showDetail = true">
    <div class="token-bar">
      <div class="token-fill" :style="{ width: Math.min(100, tokenInfo.usage) + '%' }"></div>
    </div>
    <span class="token-text">
      Token: {{ formatNumber(tokenInfo.estimatedTokens) }} / {{ formatNumber(tokenInfo.maxTokens) }}
      <span :class="getUsageClass()">({{ tokenInfo.usage }}%)</span>
    </span>
    <el-icon class="token-info-icon"><InfoFilled /></el-icon>

  </div>

  <!-- Token 详情弹窗 -->
  <el-dialog v-model="showDetail" title="Token 使用详情" width="700px">
    <div v-if="tokenInfo" class="token-detail">
      <el-row :gutter="20">
        <el-col :span="12">
          <el-statistic title="估算 Token" :value="tokenInfo.estimatedTokens" />
        </el-col>
        <el-col :span="12">
          <el-statistic title="预算上限" :value="tokenInfo.maxTokens" />
        </el-col>
      </el-row>

      <el-divider />

      <div v-if="tokenInfo.breakdown && Object.keys(tokenInfo.breakdown).length" class="breakdown-section">
        <h4>Token 消耗分布 (Top 10)</h4>
        <el-table :data="getBreakdownList()" size="small" :max-height="300">
          <el-table-column prop="key" label="字段" width="200">
            <template #default="{ row }">
              <el-tooltip :content="getFieldDescription(row.key)" placement="top">
                <span>{{ row.key }}</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column prop="tokens" label="Tokens" width="120" align="right" />
          <el-table-column prop="percent" label="占比" width="100" align="right">
            <template #default="{ row }">
              <el-progress :percentage="parseFloat(row.percent)" :stroke-width="10" :show-text="false" />
              <span style="margin-left: 8px">{{ row.percent }}%</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-alert v-if="tokenInfo.usage > 90" type="error" style="margin-top: 20px" :closable="false">
        <template #title>Token 预算严重不足</template>
        <p v-if="tokenInfo.fileCount">
          当前项目有 {{ tokenInfo.fileCount }} 个文件，建议将 Token 预算提高到：
          <strong>{{ getSuggestedBudget(tokenInfo.fileCount) }} tokens</strong>
        </p>
        <p v-else>建议提高 Token 预算或减少项目文件数</p>
      </el-alert>

      <el-alert v-else-if="tokenInfo.usage > 75" type="warning" style="margin-top: 20px" :closable="false">
        Token 使用率较高，建议适当提高预算以获得更完整的上下文
      </el-alert>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{
  sessionId: string | null
}>()

type TokenInfo = {
  estimatedTokens: number
  maxTokens: number
  usage: number
  fileCount: number
  breakdown: Record<string, number>
}

const sessionStore = useSessionStore()
const showDetail = ref(false)

const tokenInfo = computed<TokenInfo | null>(() => {
  const session = sessionStore.currentSession
  if (!props.sessionId || session?.id !== props.sessionId) return null
  const maxTokens = (session.tokenBudget || 100000) * 0.7
  const estimatedTokens = session.workspaceSnapshot?.fileCount
    ? Math.min(session.workspaceSnapshot.fileCount * 50, maxTokens * 0.9)
    : 0
  return {
    estimatedTokens,
    maxTokens,
    usage: estimatedTokens > 0 ? Math.round((estimatedTokens / maxTokens) * 100) : 0,
    fileCount: session.workspaceSnapshot?.fileCount || 0,
    breakdown: {}
  }
})

function getStatusClass() {
  if (!tokenInfo.value) return '';
  if (tokenInfo.value.usage > 90) return 'token-critical';
  if (tokenInfo.value.usage > 75) return 'token-warning';
  return 'token-normal';
}

function getUsageClass() {
  if (!tokenInfo.value) return '';
  if (tokenInfo.value.usage > 90) return 'usage-critical';
  if (tokenInfo.value.usage > 75) return 'usage-warning';
  return 'usage-normal';
}

function formatNumber(num: number) {
  return num.toLocaleString();
}

function getBreakdownList() {
  if (!tokenInfo.value?.breakdown) return [];

  const breakdown = tokenInfo.value.breakdown as Record<string, number>;
  const total = Object.values(breakdown).reduce((sum, val) => sum + Number(val || 0), 0) || 1;

  return Object.entries(breakdown)
    .map(([key, tokens]) => {
      const numericTokens = Number(tokens || 0);
      return {
        key,
        tokens: numericTokens,
        percent: ((numericTokens / total) * 100).toFixed(1)
      };
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
}

function getFieldDescription(key: string): string {
  const descriptions: Record<string, string> = {
    systemRules: '系统规则和约束',
    sessionGoal: '会话目标和用户输入',
    taskContext: '任务上下文（地图、阶段计划、证据选择）',
    workspaceSnapshot: '工作区快照（文件树和内容）',
    workspaceManifest: '工作区清单',
    selectedEvidenceContents: '选中的证据内容',
    projectMap: '项目地图',
    workspaceFocus: '工作区焦点文件',
    taskBrief: '任务契约',
    currentTask: '当前任务',
    agentProfile: 'Agent 配置',
    relevantEvents: '相关事件历史',
    relevantMemories: '相关记忆',
    ragSnippets: 'RAG 检索片段',
    artifacts: '产物',
    capabilities: '能力定义',
    constraints: '约束条件',
    summaryMemory: '摘要记忆',
    continuationState: '续跑状态'
  };
  return descriptions[key] || key;
}

function getSuggestedBudget(fileCount: number): number {
  if (fileCount < 20) return 50_000;
  if (fileCount < 100) return 150_000;
  if (fileCount < 300) return 300_000;
  return 500_000;
}
</script>

<style scoped>
.token-indicator {
  padding: 10px 16px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  background: #f5f7fa;
  border: 1px solid #dcdfe6;
  cursor: pointer;
  transition: all 0.3s;
}

.token-indicator:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.token-indicator.token-warning {
  background: #fdf6ec;
  border-color: #f5a623;
}

.token-indicator.token-critical {
  background: #fef0f0;
  border-color: #f56c6c;
}

.token-bar {
  flex: 1;
  height: 10px;
  background: #e4e7ed;
  border-radius: 5px;
  overflow: hidden;
}

.token-fill {
  height: 100%;
  background: linear-gradient(90deg, #67c23a, #409eff);
  transition: width 0.5s ease;
  border-radius: 5px;
}

.token-critical .token-fill {
  background: linear-gradient(90deg, #f56c6c, #e6a23c);
}

.token-text {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
  font-weight: 500;
}

.usage-normal {
  color: #67c23a;
}

.usage-warning {
  color: #e6a23c;
  font-weight: 600;
}

.usage-critical {
  color: #f56c6c;
  font-weight: 600;
}

.token-info-icon {
  color: #909399;
  font-size: 16px;
}

.token-detail {
  padding: 10px 0;
}

.stage-info {
  text-align: center;
  padding: 10px 0;
}

.stage-info h4 {
  margin-bottom: 12px;
  color: #303133;
}

.stage-desc {
  margin-top: 12px;
  color: #606266;
  font-size: 14px;
}

.breakdown-section h4 {
  margin-bottom: 12px;
  color: #303133;
}
</style>
