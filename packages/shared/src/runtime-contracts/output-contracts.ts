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

const PostReviewActionSchema = Type.Union([
  strictObject({
    action: Type.Literal('request_workspace_context'),
    reason: NonEmptyString,
    missingPaths: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })
  }),
  strictObject({
    action: Type.Literal('deliver_with_limitations'),
    limitations: Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })
  }),
  strictObject({
    action: Type.Literal('save_progress'),
    artifactIds: Type.Array(NonEmptyString, { uniqueItems: true })
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
  priority: literalUnion(['low', 'normal', 'high', 'critical'] as const),
  shouldPause: Type.Boolean(),
  affectedTaskIds: StringArray,
  affectedAgentIds: StringArray,
  requiresBriefRevision: Type.Boolean(),
  requiresUserConfirmation: Type.Boolean(),
  coordinatorInstruction: NonEmptyString
});

export const runtimeOutputSchemas = {
  agent_message: AgentMessageOutputSchema,
  task_acceptance_decision: TaskAcceptanceDecisionOutputSchema,
  task_brief: TaskBriefOutputSchema,
  task_execution_result: TaskExecutionResultOutputSchema,
  post_review_report: PostReviewReportOutputSchema,
  final_delivery: FinalDeliveryOutputSchema,
  user_message_handling_plan: UserMessageHandlingPlanOutputSchema
} as const;

export type AgentMessageOutput = Static<typeof AgentMessageOutputSchema>;
export type RuntimeContextRequestOutput = Static<typeof RuntimeContextRequestSchema>;
export type RuntimeHandoffSuggestion = Static<typeof HandoffSuggestionSchema>;
export type SuggestedAgentTask = Static<typeof SuggestedAgentTaskSchema>;
export type TaskAcceptanceDecisionOutput = Static<typeof TaskAcceptanceDecisionOutputSchema>;
export type TaskBriefOutput = Static<typeof TaskBriefOutputSchema>;
export type TaskExecutionResultOutput = Static<typeof TaskExecutionResultOutputSchema>;
export type PostReviewAction = Static<typeof PostReviewActionSchema>;
export type PostReviewReportOutput = Static<typeof PostReviewReportOutputSchema>;
export type FinalDeliveryOutput = Static<typeof FinalDeliveryOutputSchema>;
export type UserMessageHandlingPlanOutput = Static<typeof UserMessageHandlingPlanOutputSchema>;

export type RuntimeOutput =
  | AgentMessageOutput
  | TaskAcceptanceDecisionOutput
  | TaskBriefOutput
  | TaskExecutionResultOutput
  | PostReviewReportOutput
  | FinalDeliveryOutput
  | UserMessageHandlingPlanOutput;

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
    priority: 'normal',
    shouldPause: false,
    affectedTaskIds: [],
    affectedAgentIds: [],
    requiresBriefRevision: false,
    requiresUserConfirmation: false,
    coordinatorInstruction: 'Answer the user question.'
  }
} as const satisfies { [K in RuntimeOutput['kind']]: RuntimeOutputByKind[K] };
