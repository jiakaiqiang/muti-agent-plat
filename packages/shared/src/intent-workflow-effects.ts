import { INTENT_EFFECT_KINDS, type IntentSegment } from './runtime-contracts/intent-understanding.js';

/** Published declaration of required effects, never a grant. Missing means unknown. */
export type IntentWorkflowEffects = {
  contractVersion: 'intent-workflow-effects-v1';
  effects: Array<Pick<IntentSegment['requestedEffects'][number], 'kind' | 'target'>>;
};
export function isIntentWorkflowEffects(value: unknown): value is IntentWorkflowEffects {
  const row = value as IntentWorkflowEffects;
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.contractVersion !== 'intent-workflow-effects-v1' ||
    Object.keys(row).some(key => !['contractVersion', 'effects'].includes(key)) || !Array.isArray(row.effects) || row.effects.length > 16) return false;
  const keys = new Set<string>();
  return row.effects.every(effect => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect) || Object.keys(effect).some(key => !['kind', 'target'].includes(key)) ||
      !INTENT_EFFECT_KINDS.includes(effect.kind) || !effect.target || typeof effect.target !== 'object' || Array.isArray(effect.target) ||
      Object.keys(effect.target).some(key => !['kind', 'refId'].includes(key)) ||
      !['workspace', 'source', 'artifact', 'test_runner', 'command', 'external', 'unresolved'].includes(effect.target.kind) ||
      !(effect.target.refId === null || (typeof effect.target.refId === 'string' && effect.target.refId.trim().length > 0 && effect.target.refId.length <= 200))) return false;
    const key = JSON.stringify([effect.kind, effect.target.kind, effect.target.refId]);
    if (keys.has(key)) return false;
    keys.add(key); return true;
  });
}
