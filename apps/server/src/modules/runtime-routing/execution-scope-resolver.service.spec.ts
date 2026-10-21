import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_EFFECT_KINDS, intentUnderstandingExample, type IntentSegment } from '@agent-cluster/shared';
import { resolveIntentEffectScope, type IntentScopePolicy } from './execution-scope-resolver.service.js';

function policy(): IntentScopePolicy {
  return { grants: [], resources: [], enforceableProhibitions: [], phaseAllowed: [...INTENT_EFFECT_KINDS],
    toolAllowed: [...INTENT_EFFECT_KINDS], workspaceAllowed: [...INTENT_EFFECT_KINDS], runtimeAllowed: [...INTENT_EFFECT_KINDS] };
}

test('artifact output and isolated tests do not imply source writes or arbitrary commands', () => {
  const effects: IntentSegment['requestedEffects'] = [
    { kind: 'write_artifact', target: { kind: 'artifact', refId: 'report' }, evidenceRefs: ['request'] },
    { kind: 'run_tests', target: { kind: 'test_runner', refId: 'isolated-tests' }, evidenceRefs: ['request'] },
    { kind: 'modify_source', target: { kind: 'source', refId: 'login' }, evidenceRefs: ['request'] }
  ];
  const rules = policy();
  rules.resources = effects.map(effect => effect.target);
  rules.grants = effects.slice(0, 2).map((effect, index) => ({ id: `grant-${index}`, effect: effect.kind,
    resource: effect.target, revision: 1, sourceEventId: 'message-1' }));
  const result = resolveIntentEffectScope({ ...intentUnderstandingExample.segments[0], requestedEffects: effects }, rules);
  assert.deepEqual(result.scope.effects.map(effect => effect.kind), ['write_artifact', 'run_tests']);
  assert.ok(result.errors.includes('EFFECT_NOT_AUTHORIZED'));
  rules.runtimeAllowed = ['answer'];
  assert.equal(resolveIntentEffectScope({ ...intentUnderstandingExample.segments[0], requestedEffects: effects }, rules).scope.effects.length, 0);
});

test('scoped database prohibition is retained without disabling authorized changes to other sources', () => {
  const app = { kind: 'source' as const, refId: 'login-ui' };
  const database = { kind: 'source' as const, refId: 'database-schema' };
  const prohibition = { effectKind: 'modify_source' as const, object: database, scope: 'work_item' as const, evidenceRefs: ['request'] };
  const segment: IntentSegment = { ...intentUnderstandingExample.segments[0], requestedEffects: [
    { kind: 'modify_source', target: app, evidenceRefs: ['request'] },
    { kind: 'modify_source', target: database, evidenceRefs: ['request'] }], prohibitions: [prohibition] };
  const rules = policy();
  rules.resources = [app, database];
  rules.grants = rules.resources.map(resource => ({ id: resource.refId!, effect: 'modify_source', resource,
    revision: 1, sourceEventId: 'message-1' }));
  assert.ok(resolveIntentEffectScope(segment, rules).errors.includes('PROHIBITION_NOT_ENFORCEABLE'));
  rules.enforceableProhibitions = [prohibition];
  const result = resolveIntentEffectScope(segment, rules);
  assert.deepEqual(result.scope.effects.map(effect => effect.target.refId), ['login-ui']);
  assert.ok(result.errors.includes('EFFECT_PROHIBITED'));
  assert.deepEqual(result.scope.prohibitions, [prohibition]);
});
