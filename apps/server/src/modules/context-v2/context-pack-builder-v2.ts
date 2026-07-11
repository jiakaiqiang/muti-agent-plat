import type {
  ContextEnvelopeV2,
  ContextEnvelopeV2Budget,
  ContextEnvelopeV2Layer,
  ContextL0WorkspaceIdentity,
  ContextL1NavigationManifest,
  ContextL2ProjectMap,
  ContextL3SelectedEvidence,
  ContextL4ToolResults,
  ContextL5SummaryMemory,
  ContextL6DeliveryArtifacts,
  UUID
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { allowedLayersForPhase, type ContextPhase } from './phase-context-policy.js';

const EMPTY_L1: ContextL1NavigationManifest = { entries: [], truncated: false };
const EMPTY_L2: ContextL2ProjectMap = { source: 'generated', modules: [] };
const EMPTY_L3: ContextL3SelectedEvidence = { files: [], totalByteLength: 0, truncated: false };
const EMPTY_L4: ContextL4ToolResults = { calls: [] };
const EMPTY_L5: ContextL5SummaryMemory = { bullets: [], turnCount: 0 };
const EMPTY_L6: ContextL6DeliveryArtifacts = { changeSetIds: [], reportIds: [] };

export interface BuildContextEnvelopeV2Args {
  phase: ContextPhase;
  sessionId: UUID;
  l0: ContextL0WorkspaceIdentity;
  l1?: ContextL1NavigationManifest;
  l2?: ContextL2ProjectMap;
  l3?: ContextL3SelectedEvidence;
  l4?: ContextL4ToolResults;
  l5?: ContextL5SummaryMemory;
  l6?: ContextL6DeliveryArtifacts;
  budget: ContextEnvelopeV2Budget;
  createdAt?: string;
}

export function buildContextEnvelopeV2(args: BuildContextEnvelopeV2Args): ContextEnvelopeV2 {
  const allowed = new Set<ContextEnvelopeV2Layer>(allowedLayersForPhase(args.phase));
  return {
    version: 'v2',
    createdAt: args.createdAt ?? nowIso(),
    workspaceId: args.l0.workspaceId,
    sessionId: args.sessionId,
    L0: args.l0,
    L1: allowed.has('L1') ? args.l1 ?? EMPTY_L1 : EMPTY_L1,
    L2: allowed.has('L2') ? args.l2 ?? EMPTY_L2 : EMPTY_L2,
    L3: allowed.has('L3') ? args.l3 ?? EMPTY_L3 : EMPTY_L3,
    L4: allowed.has('L4') ? args.l4 ?? EMPTY_L4 : EMPTY_L4,
    L5: allowed.has('L5') ? args.l5 ?? EMPTY_L5 : EMPTY_L5,
    L6: allowed.has('L6') ? args.l6 ?? EMPTY_L6 : EMPTY_L6,
    budget: args.budget
  };
}
