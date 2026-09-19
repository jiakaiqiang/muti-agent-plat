import { createHash } from 'node:crypto';
import type { AgentTask, InvocationPlan, TaskAcceptanceDecisionOutput } from '@agent-cluster/shared';

/** The requirement versions an acceptance was granted against (phase 5 AC4). */
export type AcceptanceRequirementVersion = {
  workItemRevision: number;
  /** Absent before the requirement has a published document version. */
  documentRevision?: number;
  contentHash?: string;
};

export function acceptanceFingerprint(
  task: AgentTask,
  plan: InvocationPlan,
  dependencyEvidence: unknown,
  requirementVersion?: AcceptanceRequirementVersion
) {
  return createHash('sha256').update(JSON.stringify({
    task: { id: task.id, sessionId: task.sessionId, workItemId: task.workItemId, title: task.title,
      description: task.description, assignee: task.assignee, acceptanceCriteria: task.acceptanceCriteria,
      dependsOnTaskIds: task.dependsOnTaskIds, workflowNodeRunId: task.workflowNodeRunId,
      workflowAttempt: task.workflowAttempt, contextRequirements: task.contextRequirements,
      verificationPlan: task.verificationPlan, executionPurpose: task.executionPurpose },
    agent: plan.agent, tools: plan.toolCatalog, target: plan.executionTarget,
    workspace: { id: plan.contextEnvelope.L0.workspace.workspaceId, revision: plan.contextEnvelope.L0.workspace.revision.id },
    dependencyEvidence,
    // A completed acceptance is evidence about one requirement version. Leaving
    // this out let a revised requirement reuse the old checkpoint, crediting new
    // scope with work accepted against the text the user has since changed.
    requirementVersion: requirementVersion ?? null
  })).digest('hex');
}

export function explicitTaskPreflight(task: AgentTask, plan: InvocationPlan, dependenciesReady: boolean): TaskAcceptanceDecisionOutput | undefined {
  if (!task.workflowNodeRunId || task.assignee?.type !== 'agent' || task.assignee.id !== plan.agent.agentId ||
    !task.description.trim() || !task.acceptanceCriteria.length || !dependenciesReady ||
    plan.pendingApprovals?.length || plan.toolCatalog.decisions.some(item => item.status === 'blocked' &&
      item.reasons.some(reason => !['PHASE_BLOCKED', 'INVOCATION_POLICY_BLOCKED'].includes(reason)))) return;
  return { kind: 'task_acceptance_decision', schemaVersion: '1.0', status: 'accepted',
    reason: '已确认工作流指派、任务范围、依赖与执行权限，可以开始执行。', missingContext: [],
    requestedContext: null, handoffSuggestion: null, confidence: null, alternativeAgentKeys: [], alternativeAgentIds: [], agentMessages: [] };
}
