import type { AgentTaskStatus, WorkflowRunStatus } from './contracts.js';

/**
 * Deterministic answer to "where is this up to?".
 *
 * A progress question is the one execution-time message that needs no model at
 * all: every fact is already in the published graph, the task list and the
 * change queue. Keeping it a pure projection means a user who asks three times
 * costs nothing, and the answer can never drift from the state it describes
 * (phase 5 AC1/AC2).
 */

/**
 * The full vocabulary an answer may use. A fixed set is what keeps a progress
 * reply from turning into model prose that claims more than the state supports.
 */
export const EXECUTION_PROGRESS_HEADLINES = {
  notStarted: '尚未开始执行',
  running: '正在执行',
  waitingUser: '等待用户决定',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消'
} as const;

export type ExecutionProgressHeadline =
  (typeof EXECUTION_PROGRESS_HEADLINES)[keyof typeof EXECUTION_PROGRESS_HEADLINES];

/** Why the run is parked. An approval gate and a rework handoff are different waits. */
export type ExecutionWaitReason = 'approval_gate' | 'revision_handoff' | 'upstream_rerun';

/** Task states that must be called out rather than folded into "still running". */
const ATTENTION_STATUSES = ['blocked', 'failed', 'rejected'] as const;
export type ExecutionAttentionReason = (typeof ATTENTION_STATUSES)[number];

export type ExecutionProgressNode = {
  id: string;
  type: 'agent' | 'human_approval' | 'robot_approval';
  name?: string;
  order: number;
};

export type ExecutionProgressRun = {
  status: WorkflowRunStatus;
  currentNodeId?: string;
  nodes: ExecutionProgressNode[];
  /** A rejected gate with no legal rework edge; the user has to decide (phase 4 T5-3). */
  pendingRevisionHandoff?: boolean;
  pendingUpstreamRerun?: boolean;
};

export type ExecutionProgressTask = {
  id: string;
  title: string;
  status: AgentTaskStatus;
  workflowNodeId?: string;
};

export type ExecutionProgressChangeRequest = {
  id: string;
  summary: string;
  status: string;
};

export type ExecutionProgressInput = {
  run?: ExecutionProgressRun;
  tasks: ExecutionProgressTask[];
  pendingChangeRequests?: ExecutionProgressChangeRequest[];
};

export type ExecutionProgressView = {
  headline: ExecutionProgressHeadline;
  currentStage?: string;
  completedStages: string[];
  remainingStages: string[];
  attentionTasks: Array<{ id: string; title: string; reason: ExecutionAttentionReason }>;
  needsAttention: boolean;
  awaitingUser: boolean;
  waitReason?: ExecutionWaitReason;
  pendingChanges: Array<{ id: string; summary: string; status: string; awaitingUser: boolean }>;
};

const NODE_FALLBACK_LABELS: Readonly<Record<ExecutionProgressNode['type'], string>> = {
  agent: '开发任务',
  human_approval: '人工确认',
  robot_approval: '质量验证'
};

export function executionProgressView(input: ExecutionProgressInput): ExecutionProgressView {
  const run = input.run;
  const nodes = [...(run?.nodes ?? [])].sort((a, b) => a.order - b.order);
  const currentIndex = run?.currentNodeId
    ? nodes.findIndex((node) => node.id === run.currentNodeId)
    : -1;
  // An unknown current node is reported as "no stage" rather than guessed at:
  // naming a stage the approved graph never declared would misdescribe the run.
  const currentStage = currentIndex >= 0 ? stageLabel(nodes[currentIndex]!) : undefined;
  const { completed, remaining } = splitStages(nodes, currentIndex, input.tasks);

  const awaitingUser = run?.status === 'waiting_human';
  const attentionTasks = input.tasks
    .filter((task): task is ExecutionProgressTask & { status: ExecutionAttentionReason } =>
      (ATTENTION_STATUSES as readonly string[]).includes(task.status))
    .map((task) => ({ id: task.id, title: task.title, reason: task.status }));

  return {
    headline: headlineFor(run),
    ...(currentStage !== undefined ? { currentStage } : {}),
    completedStages: completed,
    remainingStages: remaining,
    attentionTasks,
    needsAttention: attentionTasks.length > 0,
    awaitingUser,
    ...(awaitingUser ? { waitReason: waitReasonFor(run!) } : {}),
    pendingChanges: (input.pendingChangeRequests ?? []).map((item) => ({
      id: item.id,
      summary: item.summary,
      status: item.status,
      // Only a change sitting on the user's decision is something to act on; a
      // deferred one is parked and must not read as an open question.
      awaitingUser: item.status === 'waiting_user'
    }))
  };
}

function headlineFor(run: ExecutionProgressRun | undefined): ExecutionProgressHeadline {
  if (!run) return EXECUTION_PROGRESS_HEADLINES.notStarted;
  switch (run.status) {
    case 'waiting_human':
      return EXECUTION_PROGRESS_HEADLINES.waitingUser;
    case 'completed':
      return EXECUTION_PROGRESS_HEADLINES.completed;
    case 'failed':
      return EXECUTION_PROGRESS_HEADLINES.failed;
    case 'cancelled':
      return EXECUTION_PROGRESS_HEADLINES.cancelled;
    default:
      return EXECUTION_PROGRESS_HEADLINES.running;
  }
}

function waitReasonFor(run: ExecutionProgressRun): ExecutionWaitReason {
  if (run.pendingRevisionHandoff) return 'revision_handoff';
  if (run.pendingUpstreamRerun) return 'upstream_rerun';
  return 'approval_gate';
}

function splitStages(
  nodes: ExecutionProgressNode[],
  currentIndex: number,
  tasks: ExecutionProgressTask[]
): { completed: string[]; remaining: string[] } {
  if (currentIndex >= 0) {
    return {
      completed: nodes.slice(0, currentIndex).map(stageLabel),
      remaining: nodes.slice(currentIndex + 1).map(stageLabel)
    };
  }
  // With no current node (finished, cancelled, or a node outside the graph) the
  // task record is the only evidence of what actually got done.
  const completed: string[] = [];
  const remaining: string[] = [];
  for (const node of nodes) {
    const nodeTasks = tasks.filter((task) => task.workflowNodeId === node.id);
    const done = nodeTasks.length > 0 && nodeTasks.every((task) => task.status === 'completed');
    (done ? completed : remaining).push(stageLabel(node));
  }
  return { completed, remaining };
}

function stageLabel(node: ExecutionProgressNode): string {
  return node.name?.trim() || NODE_FALLBACK_LABELS[node.type];
}
