import type { ContextEnvelopeV2, ContextEnvelopeV2Layer } from '@agent-cluster/shared';

export interface LayerDebugSummary {
  layer: ContextEnvelopeV2Layer;
  itemCount: number;
  approxByteLength: number;
  approxTokens: number;
  truncated?: boolean;
  notes?: string[];
}

export interface ContextDebugSnapshot {
  version: 'v2';
  workspaceId: string;
  sessionId: string;
  createdAt: string;
  budget: ContextEnvelopeV2['budget'];
  layers: LayerDebugSummary[];
  droppedReasons: string[];
}

export function presentContextEnvelopeV2Debug(envelope: ContextEnvelopeV2): ContextDebugSnapshot {
  const layers: LayerDebugSummary[] = [
    summarizeL0(envelope),
    summarizeL1(envelope),
    summarizeL2(envelope),
    summarizeL3(envelope),
    summarizeL4(envelope),
    summarizeL5(envelope),
    summarizeL6(envelope)
  ];
  const droppedReasons: string[] = [];
  if (envelope.L1.truncated) droppedReasons.push('L1 navigation truncated');
  if (envelope.L3.truncated) droppedReasons.push('L3 evidence truncated');
  return {
    version: envelope.version,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    createdAt: envelope.createdAt,
    budget: envelope.budget,
    layers,
    droppedReasons
  };
}

function summarizeL0(envelope: ContextEnvelopeV2): LayerDebugSummary {
  return baseSummary('L0', 1, JSON.stringify(envelope.L0).length);
}

function summarizeL1(envelope: ContextEnvelopeV2): LayerDebugSummary {
  const summary = baseSummary('L1', envelope.L1.entries.length, JSON.stringify(envelope.L1.entries).length);
  if (envelope.L1.truncated) summary.truncated = true;
  return summary;
}

function summarizeL2(envelope: ContextEnvelopeV2): LayerDebugSummary {
  return baseSummary('L2', envelope.L2.modules.length, JSON.stringify(envelope.L2.modules).length);
}

function summarizeL3(envelope: ContextEnvelopeV2): LayerDebugSummary {
  const summary = baseSummary('L3', envelope.L3.files.length, envelope.L3.totalByteLength);
  if (envelope.L3.truncated) summary.truncated = true;
  return summary;
}

function summarizeL4(envelope: ContextEnvelopeV2): LayerDebugSummary {
  return baseSummary('L4', envelope.L4.calls.length, JSON.stringify(envelope.L4.calls).length);
}

function summarizeL5(envelope: ContextEnvelopeV2): LayerDebugSummary {
  return baseSummary('L5', envelope.L5.bullets.length, JSON.stringify(envelope.L5.bullets).length);
}

function summarizeL6(envelope: ContextEnvelopeV2): LayerDebugSummary {
  const count = envelope.L6.changeSetIds.length + envelope.L6.reportIds.length;
  return baseSummary('L6', count, JSON.stringify(envelope.L6).length);
}

function baseSummary(
  layer: ContextEnvelopeV2Layer,
  itemCount: number,
  approxByteLength: number
): LayerDebugSummary {
  return {
    layer,
    itemCount,
    approxByteLength,
    approxTokens: estimateTokens(approxByteLength)
  };
}

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / 4);
}
