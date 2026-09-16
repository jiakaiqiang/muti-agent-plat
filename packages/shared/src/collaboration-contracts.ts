import type { ISODateTime, RuntimeStopSummary, UUID } from './contracts.js';

/** Phase-0 contracts only. Exporting these helpers does not activate a server workflow. */
export const COLLABORATION_CONTRACT_VERSION = '1.0' as const;

export type CollaborationExecutionScope =
  | { kind: 'intent'; routingId: UUID }
  | { kind: 'discussion'; discussionId: UUID; delegationId?: UUID }
  | { kind: 'workflow'; workflowRunId: UUID; taskId: UUID }
  | { kind: 'summary'; checkpointKey: string };

export type CollaborationExecutionIdentity = {
  sessionId: UUID;
  workItemId: UUID;
  agentId: UUID;
  operationId: UUID;
  invocationId: UUID;
  generation: number;
  profileRevision: number;
  contextSnapshotId: UUID;
  scope: CollaborationExecutionScope;
};

/** Proposal ownership, not authentication or tool authorization. Resolve roles server-side. */
export const COLLABORATION_ACTION_OWNERS = Object.freeze({
  propose_intent_route: 'intent_router',
  apply_intent_route: 'domain_service',
  delegate_expert: 'coordinator',
  submit_expert_report: 'expert',
  publish_synthesis: 'coordinator',
  publish_requirement_document: 'coordinator',
  request_requirement_confirmation: 'coordinator',
  request_member_selection: 'coordinator',
  confirm_requirement: 'user',
  approve_member_change: 'user',
  select_workflow: 'user',
  request_workflow_start: 'user',
  create_workflow_run: 'workflow_engine',
  advance_workflow_node: 'workflow_engine',
  request_scope_change_choice: 'coordinator',
  decide_scope_change: 'user'
} as const);

export type CollaborationAction = keyof typeof COLLABORATION_ACTION_OWNERS;
export type CollaborationActionOwner = (typeof COLLABORATION_ACTION_OWNERS)[CollaborationAction];

export function isCollaborationActionOwner(role: string, action: string): boolean {
  return Object.hasOwn(COLLABORATION_ACTION_OWNERS, action) &&
    COLLABORATION_ACTION_OWNERS[action as CollaborationAction] === role;
}

export type RequirementConfirmationBinding = {
  sessionId: UUID;
  workItemId: UUID;
  workItemRevision: number;
  confirmationId: UUID;
  documentId: UUID;
  documentRevision: number;
  contentHash: string;
  businessFingerprint: string;
};

export type CollaborationMessageTarget = {
  sessionId: UUID;
  messageIdempotencyKey: string;
  workItemId?: UUID;
  workItemRevision?: number;
  replyToEventId?: UUID;
  mentionedAgentIds: readonly UUID[];
};

/** Workflow selection follows requirement confirmation; the two approvals are not conflated. */
export type CollaborationWorkflowStartBinding = {
  requirement: RequirementConfirmationBinding;
  workflowId: UUID;
  workflowVersion: number;
  workflowHash: string;
  agentMappingHash: string;
  startRequestId: UUID;
};

export type CollaborationLifecycleSnapshot = {
  contractVersion: typeof COLLABORATION_CONTRACT_VERSION;
  sessionId: UUID;
  dataEpoch: UUID;
  generation: number;
  revision: number;
  state: 'active' | 'deleting' | 'deleted';
  admission: 'open' | 'closed';
  stopStatus: RuntimeStopSummary['status'];
  deleteRequestId?: UUID;
  deletedAt?: ISODateTime;
};

export type CollaborationContractGate = {
  eligible: boolean;
  reason:
    | 'eligible' | 'legacy_snapshot' | 'invalid_snapshot' | 'unsupported_contract'
    | 'scope_mismatch' | 'stale_generation' | 'lifecycle_closed' | 'admission_closed'
    | 'stop_unconfirmed' | 'invalid_policy' | 'unsupported_feature'
    | 'execution_active' | 'explicit_upgrade_required';
};

export type CollaborationFeature =
  | 'session_lifecycle' | 'bounded_context' | 'long_term_memory' | 'layered_cache'
  | 'main_agent_discussion' | 'document_workflow_handoff' | 'execution_changes';

const featureDependencies: Readonly<Record<CollaborationFeature, readonly CollaborationFeature[]>> = {
  session_lifecycle: [],
  bounded_context: ['session_lifecycle'],
  long_term_memory: ['bounded_context'],
  layered_cache: ['long_term_memory'],
  // Cache is an optimization: disabling it must not disable the safe collaboration path.
  main_agent_discussion: ['long_term_memory'],
  document_workflow_handoff: ['main_agent_discussion'],
  execution_changes: ['document_workflow_handoff']
};

export type CollaborationPolicyParameters = {
  context?: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWorkItemTokens: number;
    safetyMarginRatio: number;
  };
  memory?: { summaryTriggerRatio: number; maxRecallCandidates: number };
  discussion?: { maxConcurrency: number; maxRounds: number };
  cache?: { maxEntries: number; maxBytes: number; ttlMs: number };
};

export type CollaborationPolicySnapshot = {
  contractVersion: typeof COLLABORATION_CONTRACT_VERSION;
  policyId: UUID;
  revision: number;
  dataEpoch: UUID;
  activation: 'disabled' | 'new_sessions_only';
  enabledFeatures: CollaborationFeature[];
  parameters: CollaborationPolicyParameters;
  capturedAt: ISODateTime;
};

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export function assertCollaborationExecutionIdentity(value: unknown): asserts value is CollaborationExecutionIdentity {
  if (!isRecord(value) || !['sessionId', 'workItemId', 'agentId', 'operationId', 'invocationId', 'contextSnapshotId']
    .every(key => nonEmpty(value[key])) || !positiveInteger(value.generation) || !positiveInteger(value.profileRevision) ||
    !validExecutionScope(value.scope)) {
    throw new Error('COLLABORATION_IDENTITY_INVALID');
  }
}

/** A collision-safe context/handle key. It is not an authorization or dispatch idempotency token. */
export function collaborationExecutionKey(value: CollaborationExecutionIdentity): string {
  assertCollaborationExecutionIdentity(value);
  const scope = value.scope;
  const scopeParts = scope.kind === 'intent' ? [scope.kind, scope.routingId]
    : scope.kind === 'discussion' ? [scope.kind, scope.discussionId, scope.delegationId ?? null]
      : scope.kind === 'workflow' ? [scope.kind, scope.workflowRunId, scope.taskId]
        : [scope.kind, scope.checkpointKey];
  return JSON.stringify([
    value.sessionId, value.workItemId, value.agentId, value.generation,
    value.operationId, value.invocationId, value.profileRevision, value.contextSnapshotId, ...scopeParts
  ]);
}

/** Compare trusted server bindings; this does not verify that a user actually approved anything. */
export function matchesRequirementConfirmation(received: unknown, current: unknown): boolean {
  if (!validConfirmation(received) || !validConfirmation(current)) return false;
  return confirmationStringFields.every(key => received[key] === current[key]) &&
    received.workItemRevision === current.workItemRevision && received.documentRevision === current.documentRevision;
}

/** New-policy eligibility only; Tool Authority, reservations and trusted stop evidence remain required. */
export function evaluateCollaborationAdmission(value: unknown, reader: {
  sessionId: UUID;
  dataEpoch: UUID;
  generation: number;
  supportedContractVersions: readonly string[];
}): CollaborationContractGate {
  if (value === undefined) return deny('legacy_snapshot');
  if (!isRecord(value)) return deny('invalid_snapshot');
  if (value.contractVersion !== COLLABORATION_CONTRACT_VERSION ||
    !reader.supportedContractVersions.includes(value.contractVersion)) return deny('unsupported_contract');
  if (!nonEmpty(value.sessionId) || !nonEmpty(value.dataEpoch) ||
    !positiveInteger(value.generation) || !positiveInteger(value.revision) ||
    typeof value.state !== 'string' || !['active', 'deleting', 'deleted'].includes(value.state) ||
    typeof value.admission !== 'string' || !['open', 'closed'].includes(value.admission) ||
    typeof value.stopStatus !== 'string' || !['idle', 'requested', 'waiting', 'confirmed', 'unknown'].includes(value.stopStatus) ||
    (value.state !== 'active' && value.admission !== 'closed') ||
    (value.deleteRequestId !== undefined && !nonEmpty(value.deleteRequestId)) ||
    (value.deletedAt !== undefined && !validTimestamp(value.deletedAt))) return deny('invalid_snapshot');
  if (value.sessionId !== reader.sessionId || value.dataEpoch !== reader.dataEpoch) return deny('scope_mismatch');
  if (value.generation !== reader.generation) return deny('stale_generation');
  if (value.state !== 'active') return deny('lifecycle_closed');
  if (value.admission !== 'open') return deny('admission_closed');
  if (value.stopStatus !== 'idle' && value.stopStatus !== 'confirmed') return deny('stop_unconfirmed');
  return { eligible: true, reason: 'eligible' };
}

export function createCollaborationPolicySnapshot(value: unknown): DeepReadonly<CollaborationPolicySnapshot> {
  if (!validPolicy(value)) throw new Error('COLLABORATION_POLICY_INVALID');
  const snapshot = structuredClone(value) as CollaborationPolicySnapshot;
  return deepFreeze(snapshot);
}

/** No global rollout flag is read here, and existing Sessions are never auto-upgraded. */
export function evaluateCollaborationPolicyAdoption(value: unknown, reader: {
  dataEpoch: UUID;
  supportedContractVersions: readonly string[];
  supportedFeatures: readonly string[];
  sessionKind: 'new' | 'existing';
  executionActive: boolean;
  stopConfirmed: boolean;
  explicitUpgrade: boolean;
}): CollaborationContractGate {
  if (!validPolicy(value)) return deny('invalid_policy');
  if (!reader.supportedContractVersions.includes(value.contractVersion)) return deny('unsupported_contract');
  if (value.dataEpoch !== reader.dataEpoch) return deny('scope_mismatch');
  if (value.enabledFeatures.some(feature => !reader.supportedFeatures.includes(feature))) return deny('unsupported_feature');
  if (reader.executionActive) return deny('execution_active');
  if (!reader.stopConfirmed) return deny('stop_unconfirmed');
  if (reader.sessionKind === 'existing' && !reader.explicitUpgrade) return deny('explicit_upgrade_required');
  return { eligible: true, reason: 'eligible' };
}

const confirmationStringFields = [
  'sessionId', 'workItemId', 'confirmationId', 'documentId', 'contentHash', 'businessFingerprint'
] as const;

function validConfirmation(value: unknown): value is RequirementConfirmationBinding {
  return isRecord(value) && confirmationStringFields.every(key => nonEmpty(value[key])) &&
    positiveInteger(value.workItemRevision) && positiveInteger(value.documentRevision);
}

function validExecutionScope(scope: unknown): boolean {
  if (!isRecord(scope)) return false;
  switch (scope.kind) {
    case 'intent': return nonEmpty(scope.routingId);
    case 'discussion': return nonEmpty(scope.discussionId) &&
      (scope.delegationId === undefined || nonEmpty(scope.delegationId));
    case 'workflow': return nonEmpty(scope.workflowRunId) && nonEmpty(scope.taskId);
    case 'summary': return nonEmpty(scope.checkpointKey);
    default: return false;
  }
}

function validPolicy(value: unknown): value is CollaborationPolicySnapshot {
  if (!isRecord(value) || value.contractVersion !== COLLABORATION_CONTRACT_VERSION ||
    Object.keys(value).some(key => !['contractVersion', 'policyId', 'revision', 'dataEpoch', 'activation',
      'enabledFeatures', 'parameters', 'capturedAt'].includes(key)) ||
    !nonEmpty(value.policyId) || !nonEmpty(value.dataEpoch) || !positiveInteger(value.revision) ||
    !validTimestamp(value.capturedAt) || typeof value.activation !== 'string' ||
    !['disabled', 'new_sessions_only'].includes(value.activation) ||
    !Array.isArray(value.enabledFeatures) || !isRecord(value.parameters)) return false;
  const features = value.enabledFeatures;
  if (new Set(features).size !== features.length ||
    Array.from(features).some(feature => typeof feature !== 'string' || !Object.hasOwn(featureDependencies, feature)) ||
    (value.activation === 'disabled' && features.length !== 0)) return false;
  if (features.some(feature => featureDependencies[feature as CollaborationFeature].some(dep => !features.includes(dep)))) return false;
  const parameters = value.parameters;
  if (Object.keys(parameters).some(key => !['context', 'memory', 'discussion', 'cache'].includes(key))) return false;
  if (parameters.context !== undefined && (!validNumberGroup(parameters.context,
    ['maxInputTokens', 'maxOutputTokens', 'maxWorkItemTokens'], ['safetyMarginRatio']) ||
    parameters.context.maxWorkItemTokens < parameters.context.maxInputTokens + parameters.context.maxOutputTokens)) return false;
  if (parameters.memory !== undefined && !validNumberGroup(parameters.memory, ['maxRecallCandidates'], ['summaryTriggerRatio'])) return false;
  if (parameters.discussion !== undefined && !validNumberGroup(parameters.discussion, ['maxConcurrency', 'maxRounds'])) return false;
  if (parameters.cache !== undefined && !validNumberGroup(parameters.cache, ['maxEntries', 'maxBytes', 'ttlMs'])) return false;
  return (!features.includes('bounded_context') || parameters.context !== undefined) &&
    (!features.includes('long_term_memory') || parameters.memory !== undefined) &&
    (!features.includes('main_agent_discussion') || parameters.discussion !== undefined) &&
    (!features.includes('layered_cache') || parameters.cache !== undefined);
}

function validNumberGroup(value: unknown, integers: readonly string[], ratios: readonly string[] = []): value is Record<string, number> {
  return isRecord(value) && Object.keys(value).every(key => [...integers, ...ratios].includes(key)) &&
    integers.every(key => positiveInteger(value[key])) &&
    ratios.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0 && value[key] < 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return nonEmpty(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function deny(reason: CollaborationContractGate['reason']): CollaborationContractGate {
  return { eligible: false, reason };
}

function deepFreeze<T extends object>(value: T): DeepReadonly<T> {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}
