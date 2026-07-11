import type { ContextEnvelopeV2Layer } from '@agent-cluster/shared';

export type ContextPhase = 'discussion' | 'execution' | 'post_review' | 'delivery';

const PHASE_LAYER_MAP: Record<ContextPhase, readonly ContextEnvelopeV2Layer[]> = {
  discussion: ['L0', 'L1', 'L2', 'L5'],
  execution: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
  post_review: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
  delivery: ['L0', 'L6']
};

export function allowedLayersForPhase(phase: ContextPhase): readonly ContextEnvelopeV2Layer[] {
  return PHASE_LAYER_MAP[phase];
}

export function isLayerAllowedInPhase(phase: ContextPhase, layer: ContextEnvelopeV2Layer): boolean {
  return PHASE_LAYER_MAP[phase].includes(layer);
}
