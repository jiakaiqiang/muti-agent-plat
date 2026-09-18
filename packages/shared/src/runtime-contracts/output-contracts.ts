import { Type, type Static } from '@sinclair/typebox';
import { RuntimeArtifactOutputSchema, RuntimeTaskEvidenceRefSchema } from './artifact-contracts.js';
import { RUNTIME_OUTPUT_SCHEMA_VERSION } from './contract-types.js';
import {
  NonEmptyString,
  NullableString,
  StringArray,
  literalUnion,
  strictObject
} from './schema-primitives.js';

const RuntimeOutputHeader = {
  schemaVersion: Type.Literal(RUNTIME_OUTPUT_SCHEMA_VERSION)
} as const;

export const AgentMessageOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('agent_message'),
  messageKind: literalUnion(['discussion', 'answer', 'handoff', 'progress', 'risk', 'decision', 'summary'] as const),
  content: NonEmptyString,
  targetAgentIds: StringArray,
  targetAgentKeys: StringArray,
  mentionedAgentIds: StringArray,
  relatedTaskIds: StringArray
});

const RuntimeContextRequestSchema = strictObject({
  reason: NonEmptyString,
  requestedRefs: Type.Array(RuntimeTaskEvidenceRefSchema),
  requestedPaths: StringArray,
  requestedDirectories: Type.Union([Type.Array(strictObject({
    path: NonEmptyString,
    depth: Type.Union([Type.Number({ minimum: 0, maximum: 4 }), Type.Null()])
  })), Type.Null()]),
  requestedSearches: Type.Union([Type.Array(strictObject({
    query: NonEmptyString,
    path: NullableString,
    include: Type.Union([StringArray, Type.Null()]),
    exclude: Type.Union([StringArray, Type.Null()])
  })), Type.Null()]),
  requestedCommands: StringArray,
  followUpInstruction: NullableString
});

const HandoffSuggestionSchema = strictObject({
  targetAgentKey: NullableString,
  targetAgentId: NullableString,
  reason: NonEmptyString,
  missingContext: StringArray,
  riskLevel: Type.Union([literalUnion(['low', 'medium', 'high'] as const), Type.Null()])
});

export const TaskAcceptanceDecisionOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('task_acceptance_decision'),
  status: literalUnion(['accepted', 'blocked', 'rejected'] as const),
  reason: NonEmptyString,
  missingContext: StringArray,
  requestedContext: Type.Union([RuntimeContextRequestSchema, Type.Null()]),
  handoffSuggestion: Type.Union([HandoffSuggestionSchema, Type.Null()]),
  confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  alternativeAgentKeys: StringArray,
  alternativeAgentIds: StringArray,
  agentMessages: Type.Array(AgentMessageOutputSchema)
});

const SuggestedAgentTaskSchema = strictObject({
  title: NonEmptyString,
  description: NonEmptyString,
  suggestedAgentKey: NullableString,
  routingMode: Type.Union([
    literalUnion(['coordinator_controlled', 'agent_suggested', 'agent_delegated'] as const),
    Type.Null()
  ]),
  assignmentReason: NullableString,
  contextRequirements: StringArray,
  verificationPlan: StringArray,
  riskNotes: StringArray,
  requiresUserConfirmation: Type.Boolean(),
  dependsOnTaskTitles: StringArray,
  acceptanceCriteria: StringArray
});

export const TaskBriefOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('task_brief'),
  goal: NonEmptyString,
  scope: StringArray,
  outOfScope: StringArray,
  constraints: StringArray,
  acceptanceCriteria: StringArray,
  risks: StringArray,
  openQuestions: StringArray,
  suggestedTasks: Type.Array(SuggestedAgentTaskSchema)
});

export const TaskExecutionResultOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('task_execution_result'),
  status: literalUnion(['completed', 'failed', 'blocked', 'needs_review'] as const),
  summary: NonEmptyString,
  completedItems: StringArray,
  changedArtifacts: Type.Array(RuntimeArtifactOutputSchema),
  requestedContext: Type.Union([RuntimeContextRequestSchema, Type.Null()]),
  agentMessages: Type.Array(AgentMessageOutputSchema),
  nextSuggestedActions: StringArray,
  risks: StringArray
});

const FileHashSchema = strictObject({
  algorithm: Type.Literal('sha256'),
  value: Type.String({ pattern: '^[a-f0-9]{64}$' })
});

export const FileRevisionCandidateOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('file_revision_candidate'),
  revisionId: NonEmptyString,
  chainId: NonEmptyString,
  iteration: Type.Integer({ minimum: 1 }),
  sourceDraftHash: FileHashSchema,
  evidenceHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  content: Type.String(),
  summary: NonEmptyString,
  incorporatedAgentResultIds: Type.Array(NonEmptyString, { minItems: 1 }),
  unresolvedConflicts: Type.Array(strictObject({
    agentResultIds: StringArray,
    description: NonEmptyString
  }))
});

const PostReviewActionSchema = Type.Union([
  strictObject({
    action: Type.Literal('request_workspace_context'),
    reason: NonEmptyString,
    missingPaths: Type.Array(NonEmptyString, { minItems: 1 })
  }),
  strictObject({
    action: Type.Literal('deliver_with_limitations'),
    limitations: Type.Array(NonEmptyString, { minItems: 1 })
  }),
  strictObject({
    action: Type.Literal('save_progress'),
    artifactIds: Type.Array(NonEmptyString)
  }),
  strictObject({
    action: Type.Literal('cancel'),
    reason: NullableString
  })
]);

export const PostReviewReportOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('post_review_report'),
  isConsistentWithBrief: Type.Boolean(),
  matchedItems: StringArray,
  mismatchedItems: StringArray,
  missingItems: StringArray,
  outOfScopeChanges: StringArray,
  testResults: StringArray,
  recommendation: literalUnion(['deliver', 'rework', 'ask_user'] as const),
  actions: Type.Array(PostReviewActionSchema)
});

export const FinalDeliveryOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('final_delivery'),
  summary: NonEmptyString,
  completedItems: StringArray,
  incompleteItems: StringArray,
  risks: StringArray,
  artifactRefs: StringArray
});

export const UserMessageHandlingPlanOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('user_message_handling_plan'),
  intent: literalUnion([
    'clarification',
    'constraint',
    'command',
    'question',
    'correction',
    'knowledge_input',
    'preference_input'
  ] as const),
  requirementRelation: literalUnion(['continuation', 'new_requirement'] as const),
  failedExecutionAction: literalUnion(['none', 'resume', 'replan'] as const),
  priority: literalUnion(['low', 'normal', 'high', 'critical'] as const),
  shouldPause: Type.Boolean(),
  affectedTaskIds: StringArray,
  affectedAgentIds: StringArray,
  requiresBriefRevision: Type.Boolean(),
  requiresUserConfirmation: Type.Boolean(),
  coordinatorInstruction: NonEmptyString
});

export const IntentRoutingDecisionOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('intent_routing_decision'),
  dialogueAct: literalUnion([
    'clarification',
    'constraint',
    'command',
    'question',
    'correction',
    'knowledge_input',
    'preference_input'
  ] as const),
  scopeRelation: literalUnion([
    'same_requirement',
    'related_new_requirement',
    'independent_new_requirement',
    'ambiguous'
  ] as const),
  contextPolicy: literalUnion([
    'inherit_confirmed',
    'inherit_selected',
    'clean_task_context',
    'ask_user'
  ] as const),
  requestedAction: literalUnion([
    'continue_active_work_item',
    'create_related_work_item',
    'create_independent_work_item',
    'clarify',
    'pause',
    'cancel',
    'confirm',
    'reject',
    'resume',
    'replan'
  ] as const),
  selectedWorkItemId: NullableString,
  selectedDecisionIds: StringArray,
  selectedArtifactIds: StringArray,
  requestedAgentIds: StringArray,
  goalSegments: StringArray,
  missingFields: StringArray,
  ambiguityReasons: StringArray,
  reasonCodes: StringArray,
  riskLevel: literalUnion(['low', 'medium', 'high'] as const),
  modelConfidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])
});

/**
 * The coordinator's proposal for one bounded discussion round (phase 3).
 * It is a proposal only: membership, budget and confirmation are decided by
 * the domain service that validates it, never by the model. The shape is
 * closed so a member addition or an approval cannot ride along as an extra
 * field.
 */
const DiscussionConsultationProposalSchema = strictObject({
  targetAgentKey: NonEmptyString,
  objective: NonEmptyString,
  expectedResult: NonEmptyString
});

export const DiscussionPlanOutputSchema = strictObject({
  ...RuntimeOutputHeader,
  kind: Type.Literal('discussion_plan'),
  objective: NonEmptyString,
  gaps: StringArray,
  exitCondition: NonEmptyString,
  consultations: Type.Array(DiscussionConsultationProposalSchema),
  questionsForUser: StringArray,
  readyToSummarize: Type.Boolean()
});

export const runtimeOutputSchemas = {
  agent_message: AgentMessageOutputSchema,
  task_acceptance_decision: TaskAcceptanceDecisionOutputSchema,
  task_brief: TaskBriefOutputSchema,
  task_execution_result: TaskExecutionResultOutputSchema,
  file_revision_candidate: FileRevisionCandidateOutputSchema,
  post_review_report: PostReviewReportOutputSchema,
  final_delivery: FinalDeliveryOutputSchema,
  user_message_handling_plan: UserMessageHandlingPlanOutputSchema,
  intent_routing_decision: IntentRoutingDecisionOutputSchema,
  discussion_plan: DiscussionPlanOutputSchema
} as const;

export type AgentMessageOutput = Static<typeof AgentMessageOutputSchema>;
export type RuntimeContextRequestOutput = Static<typeof RuntimeContextRequestSchema>;
export type RuntimeHandoffSuggestion = Static<typeof HandoffSuggestionSchema>;
export type SuggestedAgentTask = Static<typeof SuggestedAgentTaskSchema>;
export type TaskAcceptanceDecisionOutput = Static<typeof TaskAcceptanceDecisionOutputSchema>;
export type TaskBriefOutput = Static<typeof TaskBriefOutputSchema>;
export type TaskExecutionResultOutput = Static<typeof TaskExecutionResultOutputSchema>;
export type FileRevisionCandidateOutput = Static<typeof FileRevisionCandidateOutputSchema>;
export type PostReviewAction = Static<typeof PostReviewActionSchema>;
export type PostReviewReportOutput = Static<typeof PostReviewReportOutputSchema>;
export type FinalDeliveryOutput = Static<typeof FinalDeliveryOutputSchema>;
export type UserMessageHandlingPlanOutput = Static<typeof UserMessageHandlingPlanOutputSchema>;
export type IntentRoutingDecisionOutput = Static<typeof IntentRoutingDecisionOutputSchema>;
export type DiscussionPlanOutput = Static<typeof DiscussionPlanOutputSchema>;

export type RuntimeOutput =
  | AgentMessageOutput
  | TaskAcceptanceDecisionOutput
  | TaskBriefOutput
  | TaskExecutionResultOutput
  | FileRevisionCandidateOutput
  | PostReviewReportOutput
  | FinalDeliveryOutput
  | UserMessageHandlingPlanOutput
  | IntentRoutingDecisionOutput
  | DiscussionPlanOutput;

export type RuntimeOutputByKind = {
  [K in RuntimeOutput['kind']]: Extract<RuntimeOutput, { kind: K }>;
};

export const runtimeOutputExamples = {
  agent_message: {
    schemaVersion: '1.0',
    kind: 'agent_message',
    messageKind: 'summary',
    content: 'Summarize the result here.',
    targetAgentIds: [],
    targetAgentKeys: [],
    mentionedAgentIds: [],
    relatedTaskIds: []
  },
  task_acceptance_decision: {
    schemaVersion: '1.0',
    kind: 'task_acceptance_decision',
    status: 'accepted',
    reason: 'The task matches this agent and has enough context.',
    missingContext: [],
    requestedContext: null,
    handoffSuggestion: null,
    confidence: 1,
    alternativeAgentKeys: [],
    alternativeAgentIds: [],
    agentMessages: []
  },
  task_brief: {
    schemaVersion: '1.0',
    kind: 'task_brief',
    goal: 'State the user goal.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    suggestedTasks: [
      {
        title: 'Implement the requested change.',
        description: 'Apply the scoped change and verify the acceptance criteria.',
        suggestedAgentKey: null,
        routingMode: 'coordinator_controlled',
        assignmentReason: 'The coordinator assigns the task to the best available agent.',
        contextRequirements: [],
        verificationPlan: [],
        riskNotes: [],
        requiresUserConfirmation: false,
        dependsOnTaskTitles: [],
        acceptanceCriteria: []
      }
    ]
  },
  task_execution_result: {
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'completed',
    summary: 'Describe the completed work.',
    completedItems: [],
    changedArtifacts: [],
    requestedContext: null,
    agentMessages: [],
    nextSuggestedActions: [],
    risks: []
  },
  file_revision_candidate: {
    schemaVersion: '1.0',
    kind: 'file_revision_candidate',
    revisionId: 'revision-id',
    chainId: 'chain-id',
    iteration: 1,
    sourceDraftHash: { algorithm: 'sha256', value: '0'.repeat(64) },
    evidenceHash: '1'.repeat(64),
    content: 'Complete candidate file content.',
    summary: 'Synthesized the selected Agent results while preserving the user draft.',
    incorporatedAgentResultIds: ['agent-result-id'],
    unresolvedConflicts: []
  },
  post_review_report: {
    schemaVersion: '1.0',
    kind: 'post_review_report',
    isConsistentWithBrief: true,
    matchedItems: [],
    mismatchedItems: [],
    missingItems: [],
    outOfScopeChanges: [],
    testResults: [],
    recommendation: 'deliver',
    actions: []
  },
  final_delivery: {
    schemaVersion: '1.0',
    kind: 'final_delivery',
    summary: 'Summarize the delivery.',
    completedItems: [],
    incompleteItems: [],
    risks: [],
    artifactRefs: []
  },
  user_message_handling_plan: {
    schemaVersion: '1.0',
    kind: 'user_message_handling_plan',
    intent: 'question',
    requirementRelation: 'continuation',
    failedExecutionAction: 'none',
    priority: 'normal',
    shouldPause: false,
    affectedTaskIds: [],
    affectedAgentIds: [],
    requiresBriefRevision: false,
    requiresUserConfirmation: false,
    coordinatorInstruction: 'Answer the user question.'
  },
  intent_routing_decision: {
    schemaVersion: '1.0',
    kind: 'intent_routing_decision',
    dialogueAct: 'question',
    scopeRelation: 'same_requirement',
    contextPolicy: 'inherit_confirmed',
    requestedAction: 'continue_active_work_item',
    selectedWorkItemId: 'work-item-id',
    selectedDecisionIds: [],
    selectedArtifactIds: [],
    requestedAgentIds: [],
    goalSegments: ['Answer the current question.'],
    missingFields: [],
    ambiguityReasons: [],
    reasonCodes: ['ACTIVE_WORK_ITEM_REFERENCE'],
    riskLevel: 'low',
    modelConfidence: 0.9
  },
  discussion_plan: {
    schemaVersion: '1.0',
    kind: 'discussion_plan',
    objective: '决定存储方案并列出未决风险。',
    gaps: ['迁移成本未知', '保留期未确认'],
    exitCondition: '每个未决问题都有负责人或已交由用户决定。',
    consultations: [
      {
        targetAgentKey: 'architect',
        objective: '评估关系型与文档型存储的迁移成本与风险。',
        expectedResult: '结论、依据引用、风险与建议动作。'
      }
    ],
    questionsForUser: [],
    readyToSummarize: false
  }
} as const satisfies { [K in RuntimeOutput['kind']]: RuntimeOutputByKind[K] };
