import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { ARTIFACT_TYPES, type RuntimeOutput } from '@agent-cluster/shared';

export type RuntimeOutputKind = RuntimeOutput['kind'];

const stringArray = { type: 'array', items: { type: 'string' } } as const;
const nullableStringArray = { anyOf: [stringArray, { type: 'null' }] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const nullableObject = { type: ['object', 'null'], additionalProperties: true } as const;
const nullableObjectArray = {
  anyOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'null' }]
} as const;
const runtimeArtifactSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { enum: [...ARTIFACT_TYPES] },
    title: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    uri: { type: 'string' },
    summary: { type: 'string' },
    metadata: {
      type: 'object',
      additionalProperties: true,
      not: { required: ['content'] }
    }
  },
  required: ['type', 'title', 'content']
} as const;
const postReviewActionSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: 'request_workspace_context' },
        reason: { type: 'string', minLength: 1 },
        missingPaths: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
      },
      required: ['action', 'reason', 'missingPaths']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: 'deliver_with_limitations' },
        limitations: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
      },
      required: ['action', 'limitations']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: 'save_progress' },
        artifactIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }
      },
      required: ['action']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { const: 'cancel' },
        reason: { type: 'string', minLength: 1 }
      },
      required: ['action']
    }
  ]
} as const;

function objectSchema(
  kind: RuntimeOutputKind,
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: kind },
      ...properties
    },
    required: ['kind', ...required]
  };
}

const schemas: Record<RuntimeOutputKind, Record<string, unknown>> = {
  agent_message: objectSchema(
    'agent_message',
    {
      messageKind: { enum: ['discussion', 'answer', 'handoff', 'progress', 'risk', 'decision', 'summary'] },
      content: { type: 'string', minLength: 1 },
      targetAgentIds: nullableStringArray,
      targetAgentKeys: nullableStringArray,
      mentionedAgentIds: nullableStringArray,
      relatedTaskIds: nullableStringArray
    },
    ['messageKind', 'content']
  ),
  task_acceptance_decision: objectSchema(
    'task_acceptance_decision',
    {
      status: { enum: ['accepted', 'blocked', 'rejected'] },
      reason: { type: 'string', minLength: 1 },
      missingContext: nullableStringArray,
      requestedContext: nullableObject,
      handoffSuggestion: nullableObject,
      confidence: nullableNumber,
      alternativeAgentKeys: nullableStringArray,
      alternativeAgentIds: nullableStringArray,
      agentMessages: nullableObjectArray
    },
    ['status', 'reason']
  ),
  task_claim_decision: objectSchema(
    'task_claim_decision',
    {
      accepted: { type: 'boolean' },
      reason: { type: 'string', minLength: 1 },
      confidence: nullableNumber,
      missingContext: nullableStringArray,
      requestedContext: nullableObject,
      handoffSuggestion: nullableObject,
      alternativeAgentKeys: nullableStringArray,
      alternativeAgentIds: nullableStringArray,
      agentMessages: nullableObjectArray
    },
    ['accepted', 'reason']
  ),
  task_brief: objectSchema(
    'task_brief',
    {
      goal: { type: 'string', minLength: 1 },
      scope: stringArray,
      outOfScope: stringArray,
      constraints: stringArray,
      acceptanceCriteria: stringArray,
      risks: stringArray,
      openQuestions: stringArray,
      suggestedTasks: { type: 'array', items: { type: 'object', additionalProperties: true } }
    },
    ['goal', 'scope', 'outOfScope', 'constraints', 'acceptanceCriteria', 'risks', 'openQuestions', 'suggestedTasks']
  ),
  task_execution_result: objectSchema(
    'task_execution_result',
    {
      status: { enum: ['completed', 'failed', 'blocked', 'needs_review'] },
      summary: { type: 'string', minLength: 1 },
      completedItems: stringArray,
      changedArtifacts: { type: 'array', items: runtimeArtifactSchema },
      requestedContext: nullableObject,
      agentMessages: nullableObjectArray,
      nextSuggestedActions: stringArray,
      risks: stringArray
    },
    ['status', 'summary', 'completedItems', 'changedArtifacts', 'nextSuggestedActions', 'risks']
  ),
  post_review_report: objectSchema(
    'post_review_report',
    {
      isConsistentWithBrief: { type: 'boolean' },
      matchedItems: stringArray,
      mismatchedItems: stringArray,
      missingItems: stringArray,
      outOfScopeChanges: stringArray,
      testResults: stringArray,
      recommendation: { enum: ['deliver', 'rework', 'ask_user'] },
      actions: { type: 'array', items: postReviewActionSchema }
    },
    [
      'isConsistentWithBrief',
      'matchedItems',
      'mismatchedItems',
      'missingItems',
      'outOfScopeChanges',
      'testResults',
      'recommendation'
    ]
  ),
  final_delivery: objectSchema(
    'final_delivery',
    {
      summary: { type: 'string', minLength: 1 },
      completedItems: stringArray,
      incompleteItems: stringArray,
      risks: stringArray,
      artifactRefs: stringArray
    },
    ['summary', 'completedItems', 'incompleteItems', 'risks', 'artifactRefs']
  ),
  user_message_handling_plan: objectSchema(
    'user_message_handling_plan',
    {
      intent: {
        enum: ['clarification', 'constraint', 'command', 'question', 'correction', 'knowledge_input', 'preference_input']
      },
      priority: { enum: ['low', 'normal', 'high', 'critical'] },
      shouldPause: { type: 'boolean' },
      affectedTaskIds: stringArray,
      affectedAgentIds: stringArray,
      requiresBriefRevision: { type: 'boolean' },
      requiresUserConfirmation: { type: 'boolean' },
      coordinatorInstruction: { type: 'string', minLength: 1 }
    },
    [
      'intent',
      'priority',
      'shouldPause',
      'affectedTaskIds',
      'affectedAgentIds',
      'requiresBriefRevision',
      'requiresUserConfirmation',
      'coordinatorInstruction'
    ]
  )
};

const examples: Record<RuntimeOutputKind, Record<string, unknown>> = {
  agent_message: {
    kind: 'agent_message',
    messageKind: 'summary',
    content: 'Summarize the result here.'
  },
  task_acceptance_decision: {
    kind: 'task_acceptance_decision',
    status: 'accepted',
    reason: 'The task matches this agent and has enough context.'
  },
  task_claim_decision: {
    kind: 'task_claim_decision',
    accepted: true,
    reason: 'The task matches this agent.'
  },
  task_brief: {
    kind: 'task_brief',
    goal: 'State the user goal.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    suggestedTasks: []
  },
  task_execution_result: {
    kind: 'task_execution_result',
    status: 'completed',
    summary: 'Describe the completed work.',
    completedItems: [],
    changedArtifacts: [],
    nextSuggestedActions: [],
    risks: []
  },
  post_review_report: {
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
    kind: 'final_delivery',
    summary: 'Summarize the delivery.',
    completedItems: [],
    incompleteItems: [],
    risks: [],
    artifactRefs: []
  },
  user_message_handling_plan: {
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
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<RuntimeOutputKind, ValidateFunction>();

export function runtimeOutputSchema(kind: RuntimeOutputKind) {
  return schemas[kind];
}

export function runtimeOutputExample(kind: RuntimeOutputKind) {
  return examples[kind];
}

export function validateRuntimeOutput(value: unknown, kind: RuntimeOutputKind) {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile(runtimeOutputSchema(kind));
    validators.set(kind, validator);
  }
  const jsonValue = value === undefined ? value : (JSON.parse(JSON.stringify(value)) as unknown);
  const valid = validator(jsonValue);
  return {
    valid,
    errors: valid ? [] : (validator.errors ?? []).map(formatValidationError)
  };
}

function formatValidationError(error: ErrorObject) {
  const path = error.instancePath || '/';
  return `${path} ${error.message ?? error.keyword}`.trim();
}
