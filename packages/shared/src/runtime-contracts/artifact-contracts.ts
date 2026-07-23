import { Type, type Static } from '@sinclair/typebox';
import { RUNTIME_ARTIFACT_TYPES } from './contract-types.js';
import {
  NonEmptyString,
  NullableNonEmptyString,
  NullableString,
  StringArray,
  literalUnion,
  strictObject
} from './schema-primitives.js';

const AgentRunPhaseSchema = literalUnion([
  'discussion',
  'brief_generation',
  'brief_revision',
  'task_acceptance',
  'task_execution',
  'post_review',
  'final_delivery',
  'user_message_routing'
] as const);

const EvidenceSourceTypeSchema = literalUnion([
  'project_map',
  'workspace_snapshot',
  'workspace_file',
  'workspace_symbol',
  'log',
  'test',
  'diff',
  'event_log',
  'memory',
  'artifact',
  'user_input',
  'external_reference',
  'document_fragment',
  'meeting_note',
  'data_table',
  'historical_decision'
] as const);

export const RuntimeTaskEvidenceRefSchema = strictObject({
  type: EvidenceSourceTypeSchema,
  label: NonEmptyString,
  ref: NullableString,
  estimatedTokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  selectionReason: NullableString,
  omissionReason: NullableString
});

export const RuntimeFileChangeProposalSchema = strictObject({
  path: NonEmptyString,
  content: NullableString,
  previousContent: NullableString,
  operation: literalUnion(['create', 'update', 'delete'] as const),
  encoding: Type.Literal('utf-8'),
  source: literalUnion(['stage_artifact', 'runtime_proposed_change'] as const)
});

const TaskValidationRuleSchema = strictObject({
  label: NonEmptyString,
  evidenceRequired: NonEmptyString
});

const ValidationEvidenceVerdictSchema = strictObject({
  ruleLabel: NonEmptyString,
  status: literalUnion(['passed', 'warning', 'failed', 'not_applicable'] as const),
  evidenceRefs: Type.Array(RuntimeTaskEvidenceRefSchema),
  notes: StringArray,
  missingEvidence: StringArray
});

export const RuntimeValidationEvidenceReportSchema = strictObject({
  kind: Type.Literal('validation_evidence_report'),
  domain: literalUnion(['coding', 'non_coding', 'mixed'] as const),
  intent: literalUnion([
    'inquiry',
    'analysis',
    'implementation',
    'planning',
    'troubleshooting',
    'review',
    'validation',
    'delivery',
    'qa'
  ] as const),
  stage: AgentRunPhaseSchema,
  taskTitle: NullableString,
  validatorAgentKey: NonEmptyString,
  validatorAgentId: NullableString,
  independentFromAgentKeys: StringArray,
  rules: Type.Array(TaskValidationRuleSchema),
  evidenceRefs: Type.Array(RuntimeTaskEvidenceRefSchema),
  verdicts: Type.Array(ValidationEvidenceVerdictSchema),
  overallStatus: literalUnion(['passed', 'warning', 'failed'] as const)
});

const SummaryMemorySchema = strictObject({
  goal: NonEmptyString,
  currentState: NonEmptyString,
  confirmedFacts: StringArray,
  completed: StringArray,
  decisions: StringArray,
  openQuestions: StringArray,
  risks: StringArray,
  nextSteps: StringArray,
  checkpointRefs: StringArray,
  sourceEventIds: StringArray,
  sourceArtifactIds: StringArray,
  sourceMemoryIds: StringArray
});

export const RuntimeSummaryMemoryCheckpointSchema = strictObject({
  kind: Type.Literal('summary_memory_checkpoint'),
  checkpointId: NonEmptyString,
  sessionId: NonEmptyString,
  phase: AgentRunPhaseSchema,
  taskId: NullableString,
  agentId: NullableString,
  summaryMemory: SummaryMemorySchema,
  sourceEventIds: StringArray,
  sourceArtifactIds: StringArray,
  sourceMemoryIds: StringArray,
  createdAt: NonEmptyString
});

export const RuntimeArtifactProposalMetadataSchema = strictObject({
  fileChanges: Type.Array(RuntimeFileChangeProposalSchema),
  validationEvidence: Type.Union([RuntimeValidationEvidenceReportSchema, Type.Null()]),
  summaryMemoryCheckpoint: Type.Union([RuntimeSummaryMemoryCheckpointSchema, Type.Null()])
});

export const RuntimeArtifactOutputSchema = strictObject({
  type: literalUnion(RUNTIME_ARTIFACT_TYPES),
  title: NonEmptyString,
  content: NonEmptyString,
  uri: NullableNonEmptyString,
  summary: NullableString,
  metadata: RuntimeArtifactProposalMetadataSchema
});

export type RuntimeTaskEvidenceRef = Static<typeof RuntimeTaskEvidenceRefSchema>;
export type RuntimeFileChangeProposal = Static<typeof RuntimeFileChangeProposalSchema>;
export type RuntimeValidationEvidenceReport = Static<typeof RuntimeValidationEvidenceReportSchema>;
export type RuntimeSummaryMemoryCheckpoint = Static<typeof RuntimeSummaryMemoryCheckpointSchema>;
export type RuntimeArtifactProposalMetadata = Static<typeof RuntimeArtifactProposalMetadataSchema>;
export type RuntimeArtifactProposal = Static<typeof RuntimeArtifactOutputSchema>;
export type RuntimeArtifactOutput = RuntimeArtifactProposal;
