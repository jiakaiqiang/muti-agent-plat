import { createHash } from 'node:crypto';
import type { InvocationPlan, RuntimeWriteMode } from '@agent-cluster/shared';
import { getToolsForCapability } from '../tools/capability-tool-mapping.js';

const PROPOSAL_ONLY_TOOL_NAMES = new Set(['read_file', 'search_code']);

export function applyRuntimeWriteModeOverride(
  plan: InvocationPlan,
  writeMode: RuntimeWriteMode
): InvocationPlan {
  if (writeMode !== 'proposal_only') {
    return { ...plan, executionTarget: { ...plan.executionTarget, writeMode } };
  }

  const tools = plan.toolCatalog.tools.filter((tool) => PROPOSAL_ONLY_TOOL_NAMES.has(tool.name));
  const decisions = plan.toolCatalog.decisions.map((decision) =>
    getToolsForCapability(decision.toolId).some((name) => !PROPOSAL_ONLY_TOOL_NAMES.has(name)) ||
    ['write_file', 'run_test'].includes(decision.toolKey)
      ? {
          ...decision,
          status: 'blocked' as const,
          reasons: [...new Set([...decision.reasons, 'FILE_REVISION_PROPOSAL_ONLY'])]
        }
      : decision
  );
  const catalogHash = createHash('sha256').update(JSON.stringify({ tools, decisions })).digest('hex');
  const blockedToolIds = new Set(
    decisions.filter((decision) => decision.status === 'blocked').flatMap((decision) => [decision.toolId, decision.toolKey])
  );

  return {
    ...plan,
    executionTarget: { ...plan.executionTarget, writeMode },
    toolCatalog: { tools, decisions, catalogHash },
    pendingApprovals: plan.pendingApprovals?.filter(
      (approval) => !blockedToolIds.has(approval.toolId) && !blockedToolIds.has(approval.toolKey)
    ),
    contextEnvelope: {
      ...plan.contextEnvelope,
      L0: { ...plan.contextEnvelope.L0, toolCatalogHash: catalogHash }
    }
  };
}
