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

    <!-- 裁剪阶段标签 -->
    <el-tag v-if="tokenInfo.stage && tokenInfo.stage !== 'initial'"
            :type="getStageTagType(tokenInfo.stage)"
            size="small">
      {{ getStageLabel(tokenInfo.stage) }}
    </el-tag>
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

      <div class="stage-info">
        <h4>裁剪阶段</h4>
        <el-tag :type="getStageTagType(tokenInfo.stage)" size="large">
          {{ getStageLabel(tokenInfo.stage) }}
        </el-tag>
        <p class="stage-desc">{{ getStageDescription(tokenInfo.stage) }}</p>
      </div>

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
import { ref, computed, watch } from 'vue';
// Element Plus icons 通过 auto-import 自动导入，不需要显式导入

const props = defineProps<{
  sessionId: string | null;
}>();

const tokenInfo = ref<any>(null);
const showDetail = ref(false);

async function loadTokenInfo() {
  if (!props.sessionId) {
    tokenInfo.value = null;
    return;
  }

  try {
    const res = await fetch(`/api/sessions/${props.sessionId}`);
    const data = await res.json();

    if (data.data) {
      const session = data.data;
      const maxTokens = (session.tokenBudget || 100000) * 0.7;

      // 从最新的 runtime invocation 获取实际估算
      // 这里简化处理，实际可以调用专门的端点
      tokenInfo.value = {
        estimatedTokens: session.workspaceSnapshot?.fileCount
          ? Math.min(session.workspaceSnapshot.fileCount * 50, maxTokens * 0.9)
          : 0,
        maxTokens,
        usage: 0,
        stage: 'initial',
        fileCount: session.workspaceSnapshot?.fileCount || 0,
        breakdown: {}
      };

      if (tokenInfo.value.estimatedTokens > 0) {
        tokenInfo.value.usage = Math.round((tokenInfo.value.estimatedTokens / maxTokens) * 100);
      }
    }
  } catch (error) {
    console.error('Failed to load token info:', error);
  }
}

watch(() => props.sessionId, loadTokenInfo, { immediate: true });

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

function getStageTagType(stage: string) {
  const types: Record<string, any> = {
    initial: '',
    focused: 'info',
    compact: 'warning',
    minimal: 'warning',
    'ultra-minimal': 'danger',
    emergency: 'danger'
  };
  return types[stage] || 'info';
}

function getStageLabel(stage: string) {
  const labels: Record<string, string> = {
    initial: '完整',
    focused: '聚焦',
    compact: '紧凑',
    minimal: '最小',
    'ultra-minimal': '超极限',
    emergency: '应急'
  };
  return labels[stage] || stage;
}

function getStageDescription(stage: string) {
  const descriptions: Record<string, string> = {
    initial: '使用完整上下文，包含所有相关信息',
    focused: '聚焦相关文件，保留主要信息',
    compact: '紧凑模式，减少历史和产物',
    minimal: '最小化，只保留核心导航',
    'ultra-minimal': '超极限裁剪，仅保留必要引用',
    emergency: '应急模式，仅保留目标和基本约束'
  };
  return descriptions[stage] || '未知裁剪阶段';
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
