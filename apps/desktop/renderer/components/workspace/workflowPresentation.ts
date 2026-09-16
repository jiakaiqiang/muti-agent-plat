import type { AgentTask, WorkflowNode, WorkflowNodeRun } from '@agent-cluster/shared'

export function nodeTitle(node: WorkflowNode) {
  return node.name || (node.type === 'human_approval' ? node.title : node.type === 'robot_approval' ? '质量验证' : '开发任务')
}
export function executionLabel(status: string) {
  return ({ pending: '待执行', running: '执行中', waiting: '等待处理', waiting_human: '等待确认', approved: '已通过', completed: '已完成', revision_requested: '需返工', failed: '失败', skipped: '已跳过', cancelled: '已取消', assigned: '已分配', accepted: '已接单', claimed: '已接单', blocked: '受阻', rejected: '已拒绝' } as Record<string, string>)[status] ?? status
}
export function tasksForNode(tasks: AgentTask[], runId: string, nodeId: string, nodeRuns: WorkflowNodeRun[]) {
  const refs = new Set(nodeRuns.filter((item) => item.workflowRunId === runId && item.nodeId === nodeId).map((item) => item.relatedTaskId).filter(Boolean))
  return tasks.filter((task) => task.workflowRunId === runId && task.workflowNodeId === nodeId && refs.has(task.id))
}
