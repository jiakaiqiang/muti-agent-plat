import { intentUnderstandingExample, isIntentWorkflowEffects, type IntentEffectScope, type WorkflowNode, type WorkflowVersion } from '@agent-cluster/shared';
import { resolveIntentEffectScope, type IntentScopePolicy } from '../runtime-routing/execution-scope-resolver.service.js';

/** All-or-nothing node scope compilation. Inputs are server-bound versions and current policies. */
export function compileIntentWorkflowScopes(workflow: WorkflowVersion, parent: IntentEffectScope,
  policyForNode: (node: WorkflowNode) => IntentScopePolicy) {
  const errors: Array<{ nodeId: string; code: string }> = [], scopes: Array<{ nodeId: string; scope: IntentEffectScope }> = [];
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    const fail = (code: string) => errors.push({ nodeId: node.id, code });
    if (ids.has(node.id)) { fail('WORKFLOW_NODE_ID_DUPLICATED'); continue; }
    ids.add(node.id);
    if (!isIntentWorkflowEffects(node.intentEffects)) { fail('WORKFLOW_NODE_EFFECTS_UNKNOWN'); continue; }
    if (node.type === 'human_approval' && node.intentEffects.effects.length) { fail('HUMAN_APPROVAL_CANNOT_EXECUTE_EFFECTS'); continue; }
    if (node.intentEffects.effects.some(effect => !parent.effects.some(allowed => allowed.kind === effect.kind &&
      allowed.target.kind === effect.target.kind && allowed.target.refId === effect.target.refId))) { fail('WORKFLOW_SCOPE_EXCEEDS_PARENT'); continue; }
    const policy = policyForNode(node);
    const segment = { ...structuredClone(intentUnderstandingExample.segments[0]),
      requestedEffects: node.intentEffects.effects.map(effect => ({ ...structuredClone(effect), evidenceRefs: [] })),
      prohibitions: structuredClone(parent.prohibitions) };
    const result = resolveIntentEffectScope(segment, { ...policy, grants: policy.grants.filter(grant => parent.grantIds.includes(grant.id)) });
    for (const code of result.errors) fail(code);
    scopes.push({ nodeId: node.id, scope: result.scope });
  }
  if (!workflow.nodes.length) errors.push({ nodeId: '', code: 'WORKFLOW_NODES_EMPTY' });
  return errors.length ? { status: 'blocked' as const, errors, scopes: [] } : { status: 'validated' as const, errors, scopes };
}
