import { Type, type Static } from '@sinclair/typebox';
import { literalUnion, strictObject } from './schema-primitives.js';

export const INTENT_ACTIONS = ['answer_in_chat', 'record_information', 'record_constraint', 'create_initial_work_item',
  'create_related_work_item', 'create_independent_work_item', 'enqueue_follow_up', 'resume', 'retry_failed_step', 'replan',
  'pause', 'cancel', 'acknowledge', 'resolve_confirmation', 'correct_route', 'clarify', 'reject_request'] as const;
export const INTENT_EFFECT_KINDS = ['answer', 'read_workspace', 'write_artifact', 'modify_source', 'run_tests', 'run_command', 'external_write'] as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const nullableId = Type.Union([id, Type.Null()]);
const ids = Type.Array(id, { maxItems: 64 });
const notes = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32 });
const effectKind = literalUnion(INTENT_EFFECT_KINDS);
const resource = strictObject({ kind: literalUnion(['workspace', 'source', 'artifact', 'test_runner', 'command', 'external', 'unresolved'] as const), refId: nullableId });

export const IntentUnderstandingOutputSchema = strictObject({
  schemaVersion: Type.Literal('1.0'), kind: Type.Literal('intent_understanding'),
  semanticContractVersion: Type.Literal('intent-understanding-v1'),
  segments: Type.Array(strictObject({
    localKey: id,
    dialogueAct: literalUnion(['clarification', 'constraint', 'command', 'question', 'correction', 'knowledge_input', 'preference_input'] as const),
    goal: Type.String({ minLength: 1, maxLength: 4000 }),
    scopeRelation: literalUnion(['initial_requirement', 'session_context', 'same_requirement', 'related_new_requirement', 'independent_new_requirement', 'ambiguous'] as const),
    suggestedAction: literalUnion(INTENT_ACTIONS),
    target: strictObject({ workItemId: nullableId, decisionIds: ids, artifactIds: ids, agentIds: ids,
      confirmationId: nullableId, correctionOfRoutingId: nullableId }),
    correction: Type.Union([strictObject({ supersedesDecisionId: id, expectedDecisionRevision: Type.Integer({ minimum: 1 }),
      replacementText: Type.String({ minLength: 1, maxLength: 4000 }) }), Type.Null()]),
    contextPolicy: literalUnion(['inherit_confirmed', 'inherit_selected', 'clean_task_context', 'ask_user'] as const),
    requestedEffects: Type.Array(strictObject({ kind: effectKind, target: resource, evidenceRefs: ids }), { maxItems: 16 }),
    prohibitions: Type.Array(strictObject({ effectKind, object: resource,
      scope: literalUnion(['message', 'work_item', 'subsequent'] as const), evidenceRefs: ids }), { maxItems: 16 }),
    evidence: Type.Array(strictObject({ refId: id, sourceEventId: id, start: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
      end: Type.Integer({ minimum: 1, maximum: 1_000_000 }), quote: Type.String({ minLength: 1, maxLength: 4000 }) }), { maxItems: 32 }),
    dependencies: Type.Array(strictObject({ segmentKey: id,
      condition: literalUnion(['route_committed', 'execution_completed'] as const) }), { maxItems: 7 })
  }), { minItems: 1, maxItems: 8 }),
  missingFields: notes, ambiguityReasons: notes,
  modelConfidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])
});

export type IntentUnderstandingOutput = Static<typeof IntentUnderstandingOutputSchema>;
export type IntentSegment = IntentUnderstandingOutput['segments'][number];
export type IntentEffectKind = typeof INTENT_EFFECT_KINDS[number];
export type IntentAction = typeof INTENT_ACTIONS[number];

export const intentUnderstandingExample: IntentUnderstandingOutput = {
  schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
  segments: [{ localKey: 'question', dialogueAct: 'question', goal: '解释当前系统的意图路由',
    scopeRelation: 'session_context', suggestedAction: 'answer_in_chat',
    target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
    correction: null, contextPolicy: 'clean_task_context', requestedEffects: [{ kind: 'answer',
      target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }], prohibitions: [],
    evidence: [{ refId: 'request', sourceEventId: 'message-1', start: 0, end: 11, quote: '解释当前系统的意图路由' }], dependencies: [] }],
  missingFields: [], ambiguityReasons: [], modelConfidence: null
};

/** Cross-field structure checks; source text and authorization are checked server-side. */
export function intentUnderstandingStructureErrors(value: IntentUnderstandingOutput): string[] {
  const errors: string[] = [];
  const keys = new Set(value.segments.map(segment => segment.localKey));
  if (keys.size !== value.segments.length) errors.push('SEGMENT_KEY_DUPLICATE');
  const graph = new Map(value.segments.map(segment => [segment.localKey, segment.dependencies.map(dep => dep.segmentKey)]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if ((graph.get(key) ?? []).some(visit)) return true;
    visiting.delete(key); visited.add(key); return false;
  };
  if ([...keys].some(visit)) errors.push('SEGMENT_DEPENDENCY_CYCLE');
  for (const segment of value.segments) {
    if ([segment.target.decisionIds, segment.target.artifactIds, segment.target.agentIds,
      ...segment.requestedEffects.map(effect => effect.evidenceRefs), ...segment.prohibitions.map(effect => effect.evidenceRefs)]
      .some(items => new Set(items).size !== items.length)) errors.push('REFERENCE_ID_DUPLICATE');
    if (segment.dependencies.some(dep => !keys.has(dep.segmentKey))) errors.push('SEGMENT_DEPENDENCY_UNKNOWN');
    const refs = new Set(segment.evidence.map(evidence => evidence.refId));
    if (refs.size !== segment.evidence.length) errors.push('EVIDENCE_REF_DUPLICATE');
    if (segment.evidence.some(evidence => evidence.end <= evidence.start)) errors.push('EVIDENCE_RANGE_INVALID');
    if ([...segment.requestedEffects, ...segment.prohibitions].some(effect =>
      effect.evidenceRefs.length === 0 || effect.evidenceRefs.some(ref => !refs.has(ref)))) errors.push('EFFECT_EVIDENCE_MISSING');
  }
  return [...new Set(errors)];
}
