import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentEffectScope, WorkflowVersion } from '@agent-cluster/shared';
import { compileIntentWorkflowScopes } from './intent-workflow-scope.js';
import type { IntentScopePolicy } from '../runtime-routing/execution-scope-resolver.service.js';
const effect = { kind: 'read_workspace' as const, target: { kind: 'workspace' as const, refId: 'workspace' } };
const parent: IntentEffectScope = { effects: [{ ...effect, evidenceRefs: ['user'] }], prohibitions: [], grantIds: ['read'], scopeHash: 'parent' };
const policy: IntentScopePolicy = { grants: [{ id: 'read', effect: 'read_workspace', resource: effect.target, revision: 1, sourceEventId: 'user' }],
  phaseAllowed: ['read_workspace'], toolAllowed: ['read_workspace'], workspaceAllowed: ['read_workspace'], runtimeAllowed: ['read_workspace'],
  resources: [effect.target], enforceableProhibitions: [] };
const workflow = (): WorkflowVersion => ({ id: 'v', workflowId: 'w', version: 1, name: 'flow', definitionHash: 'hash', publishedAt: 'now', publishedBy: 'owner',
  involvedAgentIds: ['agent'], edges: [], nodes: [{ id: 'node', type: 'agent', order: 0, agentId: 'agent',
    intentEffects: { contractVersion: 'intent-workflow-effects-v1', effects: [effect] } }] });

test('workflow nodes inherit only current parent-authorized effects, without mutating definitions', () => {
  const definition = workflow(), before = structuredClone(definition), result = compileIntentWorkflowScopes(definition, parent, () => policy);
  assert.equal(result.status, 'validated'); assert.deepEqual(result.scopes[0].scope.grantIds, ['read']);
  assert.deepEqual(definition, before); assert.deepEqual(result.scopes[0].scope.effects[0].target, effect.target);
});

for (const mode of ['missing', 'expansion', 'revoked', 'new-grant', 'runtime', 'prohibition'] as const) test(`workflow ${mode} blocks the entire plan, not just one node`, () => {
  const definition = workflow(), scope = structuredClone(parent), current = structuredClone(policy);
  definition.nodes.push({ ...structuredClone(definition.nodes[0]), id: 'second', order: 1 });
  if (mode === 'missing') delete definition.nodes[1].intentEffects;
  if (mode === 'expansion') definition.nodes[1].intentEffects!.effects[0] = { ...effect, kind: 'modify_source' };
  if (mode === 'revoked') current.grants[0].revokedAt = 'now';
  if (mode === 'new-grant') current.grants[0].id = 'unapproved';
  if (mode === 'runtime') current.runtimeAllowed = [];
  if (mode === 'prohibition') scope.prohibitions.push({ effectKind: 'read_workspace', object: effect.target, scope: 'work_item', evidenceRefs: ['no'] });
  const result = compileIntentWorkflowScopes(definition, scope, () => current);
  assert.equal(result.status, 'blocked'); assert.equal(result.scopes.length, 0); assert.ok(result.errors.length);
});

test('human approval is explicit zero-effect and cannot itself authorize execution', () => {
  const definition = workflow(); definition.nodes = [{ id: 'human', order: 0, type: 'human_approval', assignee: 'session_owner', title: 'Review', allowedDecisions: ['approve'],
    intentEffects: { contractVersion: 'intent-workflow-effects-v1', effects: [] } }];
  assert.equal(compileIntentWorkflowScopes(definition, parent, () => policy).status, 'validated');
  definition.nodes[0].intentEffects!.effects = [effect];
  assert.equal(compileIntentWorkflowScopes(definition, parent, () => policy).errors[0].code, 'HUMAN_APPROVAL_CANNOT_EXECUTE_EFFECTS');
});

test('scoped source prohibition is retained without blocking independently authorized workspace reads', () => {
  const scope = structuredClone(parent), current = structuredClone(policy);
  scope.prohibitions = [{ effectKind: 'modify_source', object: { kind: 'source', refId: 'schema-files' }, scope: 'work_item', evidenceRefs: ['user-no-schema'] }];
  current.enforceableProhibitions = structuredClone(scope.prohibitions);
  const result = compileIntentWorkflowScopes(workflow(), scope, () => current);
  assert.equal(result.status, 'validated'); assert.deepEqual(result.scopes[0].scope.prohibitions, scope.prohibitions);
  assert.equal(result.scopes[0].scope.effects[0].kind, 'read_workspace');
});
