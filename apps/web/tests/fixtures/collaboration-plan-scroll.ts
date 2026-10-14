// Actual component and production CSS, with long lists and no backend calls.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import type { AgentCardState, BriefEventPayload, CollaborationEvent, TaskViewState } from '../../src/types/contracts'
import CollaborationPlanView from '../../src/components/CollaborationPlanView.vue'
import '../../src/styles.css'

const timestamp = '2026-09-29T08:00:00.000Z'
const agents: AgentCardState[] = [{
  agentId: 'fixture-agent', name: '前端开发工程师', role: '前端', status: 'completed',
  recentLogs: [], waitingFor: [], activeCapabilityNames: [], usedRagSnippets: [], artifactIds: [], updatedAt: timestamp
}]
const brief: BriefEventPayload = {
  briefId: 'fixture-brief', version: 2,
  goal: '为当前贪吃蛇游戏添加撞击音效，继续游戏并保存带日期时间的排行榜。',
  scope: [], outOfScope: [], constraints: [], acceptanceCriteria: [], risks: [], openQuestions: [], requiresUserConfirmation: false
}
const tasks: TaskViewState[] = Array.from({ length: 30 }, (_, index) => ({
  taskId: `task-${index}`, title: `任务 ${index + 1} · 前端功能实现`, status: 'completed',
  assignee: { type: 'agent', id: 'fixture-agent' }, contextRequirements: [], verificationPlan: [], riskNotes: [],
  dependsOnTaskIds: [], acceptanceCriteria: [], artifacts: [],
  resultSummary: '完成音效和排行榜功能验证，记录结果与产物，并保留完整验收证据。'
}))
const events: CollaborationEvent[] = Array.from({ length: 40 }, (_, index) => ({
  id: `event-${index}`, sessionId: 'fixture-session', type: 'runtime_progress',
  actor: { type: 'agent', id: 'fixture-agent' }, toAgentIds: [],
  content: `过程记录 ${index + 1}：完成本阶段验证，继续处理后续任务。`,
  metadata: { schemaVersion: '0.1', payload: {} }, createdAt: timestamp
}))

createApp({ render: () => h('main', { class: 'workspace-main' }, [
  h('header', { class: 'workspace-header' }, '协作计划 · 区域滚动验收'),
  h(CollaborationPlanView, { brief, tasks, agents, events })
]) }).use(createPinia()).mount('#app')
