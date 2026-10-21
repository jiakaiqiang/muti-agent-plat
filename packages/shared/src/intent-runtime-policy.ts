import { INTENT_TEST_SCRIPTS, type InvocationPlan, type RuntimeType } from './contracts.js';
import type { IntentEffectScope } from './intent-plan-contracts.js';

/** CLI support is provider-specific: older local bridges have no isolated classifier. */
export function supportsRestrictedIntentClassification(runtime: RuntimeType, provider?: string): boolean {
  return runtime === 'generic_llm' || runtime === 'mock' || (runtime === 'claude_code' && provider === 'server_local');
}

export function isReadOnlyAnswerScope(scope: IntentEffectScope, workspaceId: string): boolean {
  return scope.effects.filter(effect => effect.kind === 'answer').length === 1 && scope.effects.length <= 2 &&
    scope.effects.every(effect => effect.kind === 'answer' || (effect.kind === 'read_workspace' &&
      effect.target.kind === 'workspace' && effect.target.refId === workspaceId && scope.grantIds.length > 0));
}

export function isIsolatedTestScope(scope: IntentEffectScope): boolean {
  const test = scope.effects.find(effect => effect.kind === 'run_tests');
  return Boolean(test && scope.effects.filter(effect => effect.kind === 'run_tests').length === 1 && scope.effects.length <= 2 &&
    test.target.kind === 'test_runner' && scope.grantIds.length > 0 &&
    scope.effects.every(effect => effect === test || (effect.kind === 'write_artifact' && effect.target.kind === 'artifact' &&
      /^test-runner:[a-f0-9]{64}$/.test(test.target.refId ?? '') &&
      /^test-report:[a-f0-9]{64}$/.test(effect.target.refId ?? '') &&
      effect.target.refId === test.target.refId?.replace(/^test-runner:/, 'test-report:'))) &&
    !scope.prohibitions.some(ban => scope.effects.some(effect => effect.kind === ban.effectKind)));
}

/** Capability support is intentionally conservative until an adapter has enforcement evidence. */
export function supportsIntentEffectScope(runtime: RuntimeType, scope: IntentEffectScope, workspaceId: string): boolean {
  if (runtime === 'test_runner') return isIsolatedTestScope(scope);
  if (!['generic_llm', 'mock'].includes(runtime)) return false;
  if (scope.effects.some(effect => effect.kind !== 'answer' &&
    (effect.kind !== 'read_workspace' || effect.target.kind !== 'workspace' || effect.target.refId !== workspaceId))) return false;
  // Read-only protocol tools cannot satisfy resource-specific read bans. No write tools are exposed.
  if (scope.prohibitions.some(ban => scope.effects.some(effect => effect.kind === ban.effectKind))) return false;
  return scope.effects.every(effect => effect.kind === 'answer' || scope.grantIds.length > 0);
}

export function intentScopeToolNames(scope: IntentEffectScope): string[] {
  const effects = new Set(scope.effects.map(effect => effect.kind));
  return [
    ...(effects.has('read_workspace') ? ['read_file', 'search_code'] : []),
    ...(effects.has('modify_source') ? ['write_file'] : []),
    ...(effects.has('run_tests') ? ['run_test'] : [])
  ];
}

/** Also used at the runtime/Bridge boundary so callers cannot bypass InvocationResolver. */
export function assertIntentInvocationScope(plan: InvocationPlan) {
  if (plan.executionBinding && ['brief_generation', 'brief_revision'].includes(plan.phase) &&
    (plan.admissionClass !== 'business' || !plan.dataEpoch || !plan.intentStepId || !plan.workItemId || plan.taskId || plan.resume ||
      !plan.effectScope || plan.effectScope.effects.length || plan.effectScope.grantIds.length ||
      plan.expectedOutput.kind !== (plan.phase === 'brief_revision' ? 'agent_message' : 'task_brief') || plan.expectedOutput.schemaVersion !== '1.0' ||
      !['generic_llm', 'mock'].includes(plan.executionTarget.runtimeType) || plan.executionTarget.writeMode !== 'none' ||
      plan.executionTarget.requiredCapabilities.length || plan.toolCatalog.tools.length)) {
    throw new Error('RESTRICTED_BRIEF_CAPABILITY_UNAVAILABLE');
  }
  if (plan.admissionClass === 'response' && (plan.phase !== 'user_message_response' || !plan.dataEpoch || plan.taskId ||
    !plan.intentStepId || !plan.executionBinding || !plan.effectScope || !isReadOnlyAnswerScope(plan.effectScope, plan.contextEnvelope.workspaceId) ||
    plan.expectedOutput.kind !== 'agent_message' ||
    !['generic_llm', 'mock'].includes(plan.executionTarget.runtimeType) || plan.executionTarget.writeMode !== 'none' ||
    plan.executionTarget.requiredCapabilities.some(capability => capability !== 'read') ||
    (plan.effectScope.effects.some(effect => effect.kind === 'read_workspace')
      ? plan.executionTarget.workspaceProviderKind !== 'server_local' || !plan.toolCatalog.tools.some(tool => tool.name === 'read_file')
      : plan.executionTarget.requiredCapabilities.length > 0 || plan.toolCatalog.tools.length > 0))) {
    throw new Error('RESTRICTED_RESPONSE_CAPABILITY_UNAVAILABLE');
  }
  if (plan.admissionClass === 'routing' && (plan.phase !== 'user_message_routing' || !plan.dataEpoch || plan.taskId ||
    !['intent_understanding', 'intent_routing_decision'].includes(plan.expectedOutput.kind) ||
    !supportsRestrictedIntentClassification(plan.executionTarget.runtimeType, plan.executionTarget.workspaceProviderKind) ||
    (plan.executionTarget.runtimeType === 'claude_code' && (Boolean(plan.resume) || plan.expectedOutput.schemaVersion !== '1.0')) ||
    plan.executionTarget.writeMode !== 'none' || plan.executionTarget.requiredCapabilities.length > 0 || plan.toolCatalog.tools.length > 0)) {
    throw new Error('RESTRICTED_ROUTING_CAPABILITY_UNAVAILABLE');
  }
  const scope = plan.effectScope;
  if (plan.intentTestBinding && (!scope || !isIsolatedTestScope(scope))) throw new Error('INTENT_TEST_SCOPE_REQUIRED');
  if (plan.executionBinding && !scope) throw new Error('INTENT_EFFECT_SCOPE_REQUIRED');
  if (!scope) return; // Existing records retain their legacy policy during additive migration.
  if (isIsolatedTestScope(scope)) {
    const binding = plan.intentTestBinding;
    if (!binding || binding.runnerId !== 'docker-npm-tests-v1' || !/^sha256:[a-f0-9]{64}$/.test(binding.imageId) ||
      !/^[a-f0-9]{64}$/.test(binding.bindingHash) || binding.resourceId !== `test-runner:${binding.bindingHash}` ||
      !INTENT_TEST_SCRIPTS.includes(binding.script) || binding.workspaceId !== plan.contextEnvelope.workspaceId ||
      binding.resourceId !== scope.effects.find(effect => effect.kind === 'run_tests')?.target.refId || plan.phase !== 'task_execution' ||
      plan.admissionClass !== 'business' || !plan.dataEpoch || !plan.intentStepId || !plan.workItemId || !plan.executionBinding || plan.taskId ||
      plan.executionTarget.runtimeType !== 'test_runner' || plan.executionTarget.workspaceProviderKind !== 'server_local' ||
      plan.executionTarget.writeMode !== 'none' || plan.expectedOutput.kind !== 'task_execution_result' || plan.expectedOutput.schemaVersion !== '1.0' ||
      plan.executionTarget.requiredCapabilities.length !== 1 || plan.executionTarget.requiredCapabilities[0] !== 'test' ||
      !plan.agent.capabilityIds.includes('cap-isolated-test') || plan.toolCatalog.tools.length !== 1 || plan.toolCatalog.tools[0].name !== 'run_test') {
      throw new Error('INTENT_TEST_INVOCATION_INVALID');
    }
  }
  if (!supportsIntentEffectScope(plan.executionTarget.runtimeType, scope, plan.contextEnvelope.workspaceId)) {
    throw new Error('INTENT_EFFECT_SCOPE_UNSUPPORTED');
  }
  if (!scope.effects.some(effect => effect.kind === 'modify_source') && plan.executionTarget.writeMode !== 'none') {
    throw new Error('INTENT_SOURCE_WRITE_NOT_AUTHORIZED');
  }
  const allowed = new Set(intentScopeToolNames(scope));
  if (plan.toolCatalog.tools.some(tool => !allowed.has(tool.name))) throw new Error('INTENT_TOOL_SCOPE_MISMATCH');
  if (plan.executionBinding && plan.executionBinding.effectScopeHash !== scope.scopeHash) throw new Error('INTENT_EFFECT_SCOPE_HASH_MISMATCH');
}
