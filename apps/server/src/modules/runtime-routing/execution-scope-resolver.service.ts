import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { IntentEffectGrant, IntentEffectKind, IntentEffectScope, IntentResource, IntentSegment } from '@agent-cluster/shared';

export type IntentScopePolicy = {
  grants: IntentEffectGrant[];
  phaseAllowed: IntentEffectKind[];
  toolAllowed: IntentEffectKind[];
  workspaceAllowed: IntentEffectKind[];
  runtimeAllowed: IntentEffectKind[];
  /** Resolved IDs from the workspace/adapter, never model-provided paths. */
  resources: IntentResource[];
  /** Runtime or writeback enforcement must bind each scoped prohibition. */
  enforceableProhibitions: IntentSegment['prohibitions'];
};

export function resolveIntentEffectScope(segment: IntentSegment, policy: IntentScopePolicy) {
  const errors: string[] = [];
  const effects: IntentSegment['requestedEffects'] = [];
  const grantIds = new Set<string>();
  for (const prohibition of segment.prohibitions) {
    if (prohibition.object.kind === 'unresolved' || !policy.enforceableProhibitions.some(item =>
      item.effectKind === prohibition.effectKind && sameResource(item.object, prohibition.object) && item.scope === prohibition.scope)) {
      errors.push('PROHIBITION_NOT_ENFORCEABLE');
    }
  }
  for (const effect of segment.requestedEffects) {
    const answer = effect.kind === 'answer';
    if (!answer && (effect.target.kind === 'unresolved' || !policy.resources.some(resource => sameResource(resource, effect.target)))) {
      errors.push('EFFECT_TARGET_UNRESOLVED'); continue;
    }
    const grant = policy.grants.find(item => !item.revokedAt && item.revision > 0 &&
      item.effect === effect.kind && sameResource(item.resource, effect.target));
    if (!answer && !grant) { errors.push('EFFECT_NOT_AUTHORIZED'); continue; }
    if (![policy.phaseAllowed, policy.toolAllowed, policy.workspaceAllowed, policy.runtimeAllowed].every(layer => layer.includes(effect.kind))) {
      errors.push('EFFECT_CAPABILITY_UNAVAILABLE'); continue;
    }
    if (segment.prohibitions.some(prohibition => prohibition.effectKind === effect.kind && sameResource(prohibition.object, effect.target))) {
      errors.push('EFFECT_PROHIBITED'); continue;
    }
    effects.push(structuredClone(effect));
    if (grant) grantIds.add(grant.id);
  }
  const body = { effects, prohibitions: structuredClone(segment.prohibitions), grantIds: [...grantIds].sort() };
  const scope: IntentEffectScope = { ...body, scopeHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  return { scope, errors: [...new Set(errors)] };
}

function sameResource(left: IntentResource, right: IntentResource) { return left.kind === right.kind && left.refId === right.refId; }

@Injectable()
export class ExecutionScopeResolverService {
  resolve(segment: IntentSegment, policy: IntentScopePolicy) { return resolveIntentEffectScope(segment, policy); }
}
