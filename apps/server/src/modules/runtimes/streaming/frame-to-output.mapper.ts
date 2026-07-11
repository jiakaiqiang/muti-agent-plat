import type {
  AgentMessageOutput,
  ExpectedRuntimeOutput,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeOutput,
  TaskAcceptanceDecisionOutput,
  TaskBriefOutput,
  TaskClaimDecisionOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlanOutput
} from '@agent-cluster/shared';
import { normalizeRuntimeArtifact } from '../runtime-artifact-normalizer.js';
import { normalizePostReviewActions } from '../post-review-action-normalizer.js';
import {
  isAssistantTextFrame,
  isResultFrame,
  isToolResultFrame,
  isToolUseFrame,
  type ResultFrame,
  type RuntimeStreamFrame
} from './runtime-stream-frame.js';

/**
 * 帧序列 → `RuntimeOutput` 的确定性构造。取代原 adapter 里"prompt 要求
 * 模型吐 JSON + JSON.parse 打捞"的机制。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.5。
 */

export class MapperError extends Error {
  constructor(
    message: string,
    public readonly expectedKind: ExpectedRuntimeOutput['kind']
  ) {
    super(message);
    this.name = 'MapperError';
  }
}

type ExpectedKind = ExpectedRuntimeOutput['kind'];

function firstResultFrame(frames: RuntimeStreamFrame[]): ResultFrame {
  const r = frames.find(isResultFrame);
  if (!r) {
    throw new MapperError('no result frame in stream', 'agent_message');
  }
  return r;
}

function payloadRecord(frame: ResultFrame): Record<string, unknown> {
  const p = frame.payload;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asBoolean(v: unknown, dflt = false): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

// ---------- kind mappers ----------

function toAgentMessage(frames: RuntimeStreamFrame[]): AgentMessageOutput {
  const result = firstResultFrame(frames);
  const payload = payloadRecord(result);
  const explicit = asString(payload.content);
  const accumulated = frames.filter(isAssistantTextFrame).map((f) => f.text).join('');
  const content = explicit || accumulated;
  if (!content) {
    throw new MapperError('agent_message requires non-empty content', 'agent_message');
  }
  const allowedKinds: AgentMessageOutput['messageKind'][] = [
    'discussion',
    'answer',
    'handoff',
    'progress',
    'risk',
    'decision',
    'summary'
  ];
  const messageKindRaw = asString(payload.messageKind);
  const messageKind: AgentMessageOutput['messageKind'] =
    (allowedKinds as string[]).includes(messageKindRaw)
      ? (messageKindRaw as AgentMessageOutput['messageKind'])
      : 'summary';
  return { kind: 'agent_message', messageKind, content };
}

function toTaskExecutionResult(frames: RuntimeStreamFrame[]): TaskExecutionResultOutput {
  const result = firstResultFrame(frames);
  const payload = payloadRecord(result);
  const validStatuses = ['completed', 'failed', 'blocked', 'needs_review'] as const;
  const status: TaskExecutionResultOutput['status'] = (validStatuses as readonly string[]).includes(
    asString(payload.status)
  )
    ? (payload.status as TaskExecutionResultOutput['status'])
    : 'completed';

  let changedArtifacts: RuntimeArtifactOutput[] = Array.isArray(payload.changedArtifacts)
    ? payload.changedArtifacts
        .map(normalizeRuntimeArtifact)
        .filter((artifact): artifact is RuntimeArtifactOutput => Boolean(artifact))
    : [];

  if (changedArtifacts.length === 0) {
    // 从 tool_result 帧推导 changedArtifacts:找 write_file / edit_file 类工具
    const fileChanges: Array<{ path: string; operation: 'create' | 'update' | 'delete' }> = [];
    const useMap = new Map<string, unknown>();
    for (const f of frames) {
      if (isToolUseFrame(f)) useMap.set(f.toolCallId, f.input);
      if (isToolResultFrame(f) && /write_file|edit_file|create_file/.test(f.tool)) {
        const input = useMap.get(f.toolCallId) as { path?: string } | undefined;
        const path = input?.path;
        if (path) {
          fileChanges.push({
            path,
            operation: /create/.test(f.tool) ? 'create' : 'update'
          });
        }
      }
    }
    if (fileChanges.length > 0) {
      changedArtifacts = [
        {
          type: 'code_diff',
          title: `${fileChanges.length} file change(s)`,
          content: fileChanges.map((change) => `${change.operation}: ${change.path}`).join('\n'),
          metadata: { fileChanges }
        }
      ];
    }
  }

  return {
    kind: 'task_execution_result',
    status,
    summary: asString(payload.summary),
    completedItems: asStringArray(payload.completedItems),
    changedArtifacts,
    nextSuggestedActions: asStringArray(payload.nextSuggestedActions),
    risks: asStringArray(payload.risks)
  };
}

function toTaskBrief(frames: RuntimeStreamFrame[]): TaskBriefOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  return {
    kind: 'task_brief',
    goal: asString(payload.goal),
    scope: asStringArray(payload.scope),
    outOfScope: asStringArray(payload.outOfScope),
    constraints: asStringArray(payload.constraints),
    acceptanceCriteria: asStringArray(payload.acceptanceCriteria),
    risks: asStringArray(payload.risks),
    openQuestions: asStringArray(payload.openQuestions),
    suggestedTasks: Array.isArray(payload.suggestedTasks)
      ? (payload.suggestedTasks as TaskBriefOutput['suggestedTasks'])
      : []
  };
}

function toTaskAcceptanceDecision(frames: RuntimeStreamFrame[]): TaskAcceptanceDecisionOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  const statuses = ['accepted', 'blocked', 'rejected'] as const;
  const status: TaskAcceptanceDecisionOutput['status'] = (statuses as readonly string[]).includes(
    asString(payload.status)
  )
    ? (payload.status as TaskAcceptanceDecisionOutput['status'])
    : 'accepted';
  return {
    kind: 'task_acceptance_decision',
    status,
    reason: asString(payload.reason, 'unspecified')
  };
}

function toTaskClaimDecision(frames: RuntimeStreamFrame[]): TaskClaimDecisionOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  return {
    kind: 'task_claim_decision',
    accepted: asBoolean(payload.accepted, true),
    reason: asString(payload.reason, 'unspecified')
  };
}

function toPostReviewReport(frames: RuntimeStreamFrame[]): PostReviewReportOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  const actions = normalizePostReviewActions(payload.actions);
  if (payload.actions !== undefined && payload.actions !== null && !actions) {
    throw new MapperError('post_review_report contains invalid actions', 'post_review_report');
  }
  const recos = ['deliver', 'rework', 'ask_user'] as const;
  const recommendation: PostReviewReportOutput['recommendation'] = (recos as readonly string[]).includes(
    asString(payload.recommendation)
  )
    ? (payload.recommendation as PostReviewReportOutput['recommendation'])
    : 'ask_user';
  return {
    kind: 'post_review_report',
    isConsistentWithBrief: asBoolean(payload.isConsistentWithBrief, true),
    matchedItems: asStringArray(payload.matchedItems),
    mismatchedItems: asStringArray(payload.mismatchedItems),
    missingItems: asStringArray(payload.missingItems),
    outOfScopeChanges: asStringArray(payload.outOfScopeChanges),
    testResults: asStringArray(payload.testResults),
    recommendation,
    actions
  };
}

function toFinalDelivery(frames: RuntimeStreamFrame[]): FinalDeliveryOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  return {
    kind: 'final_delivery',
    summary: asString(payload.summary),
    completedItems: asStringArray(payload.completedItems),
    incompleteItems: asStringArray(payload.incompleteItems),
    risks: asStringArray(payload.risks),
    artifactRefs: asStringArray(payload.artifactRefs)
  };
}

function toUserMessageHandlingPlan(frames: RuntimeStreamFrame[]): UserMessageHandlingPlanOutput {
  const payload = payloadRecord(firstResultFrame(frames));
  const intents = [
    'clarification',
    'constraint',
    'command',
    'question',
    'correction',
    'knowledge_input',
    'preference_input'
  ] as const;
  const intent: UserMessageHandlingPlanOutput['intent'] = (intents as readonly string[]).includes(
    asString(payload.intent)
  )
    ? (payload.intent as UserMessageHandlingPlanOutput['intent'])
    : 'question';
  const priorities = ['low', 'normal', 'high', 'critical'] as const;
  const priority: UserMessageHandlingPlanOutput['priority'] = (priorities as readonly string[]).includes(
    asString(payload.priority)
  )
    ? (payload.priority as UserMessageHandlingPlanOutput['priority'])
    : 'normal';
  return {
    kind: 'user_message_handling_plan',
    intent,
    priority,
    shouldPause: asBoolean(payload.shouldPause),
    affectedTaskIds: asStringArray(payload.affectedTaskIds),
    affectedAgentIds: asStringArray(payload.affectedAgentIds),
    requiresBriefRevision: asBoolean(payload.requiresBriefRevision),
    requiresUserConfirmation: asBoolean(payload.requiresUserConfirmation),
    coordinatorInstruction: asString(payload.coordinatorInstruction, 'proceed')
  };
}

// ---------- entry ----------

export function framesToOutput(kind: ExpectedKind, frames: RuntimeStreamFrame[]): RuntimeOutput {
  switch (kind) {
    case 'agent_message':
      return toAgentMessage(frames);
    case 'task_execution_result':
      return toTaskExecutionResult(frames);
    case 'task_brief':
      return toTaskBrief(frames);
    case 'task_acceptance_decision':
      return toTaskAcceptanceDecision(frames);
    case 'task_claim_decision':
      return toTaskClaimDecision(frames);
    case 'post_review_report':
      return toPostReviewReport(frames);
    case 'final_delivery':
      return toFinalDelivery(frames);
    case 'user_message_handling_plan':
      return toUserMessageHandlingPlan(frames);
    default: {
      const exhaustive: never = kind;
      throw new MapperError(`unknown kind: ${String(exhaustive)}`, kind);
    }
  }
}
