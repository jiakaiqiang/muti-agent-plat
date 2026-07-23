import { createHash } from 'node:crypto';
import type {
  AgentRunPhase,
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  ContextL3EvidenceFile,
  ContextL3SelectedEvidence,
  ContextAssembly,
  SessionDetail,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { buildIndexFromSnapshot } from '../workspaces/workspace-index/build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from '../workspaces/workspace-index/derive-workspace-entrypoints.js';
import { buildNavigationManifest } from './build-navigation-manifest.js';
import { buildProjectMap } from './build-project-map.js';
import { buildContextEnvelopeV2 } from './context-assembly-builder-v2.js';
import type { ContextPhase } from './phase-context-policy.js';
import { selectEvidenceWithinBudget } from './select-evidence-within-budget.js';
import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';

const DEFAULT_INPUT_TOKENS = 32_000;

/** Convert the internal assembly into the only Runtime context contract. */
export function buildEnvelopeFromContextAssembly(args: {
  session: SessionDetail;
  phase: AgentRunPhase;
  contextAssembly: ContextAssembly;
  identity: CompiledAgentIdentity;
  toolCatalogHash: string;
}): ContextEnvelopeV2 {
  const { session, contextAssembly } = args;
  const snapshot = session.workspaceSnapshot;
  const revision = snapshot?.revision ?? snapshotRevision(snapshot?.scannedAt, snapshot?.rootName ?? session.workspaceId);
  const index = snapshot ? buildIndexFromSnapshot(snapshot, revision) : [];
  const entrypoints = snapshot ? deriveWorkspaceEntrypoints(snapshot, index) : [];
  const inputTokens = contextAssembly.budget.maxInputTokens ?? session.tokenBudget ?? DEFAULT_INPUT_TOKENS;
  const evidenceTokens = Math.floor(inputTokens * 0.4);
  const allowedEvidencePaths = new Set(
    index
      .filter((entry) => entry.kind === 'file' && !entry.generated && !entry.sensitive)
      .map((entry) => entry.path)
  );
  const evidence = selectedEvidence(contextAssembly, evidenceTokens, allowedEvidencePaths);

  return buildContextEnvelopeV2({
    phase: toContextPhase(args.phase),
    sessionId: session.id,
    l0: {
      systemRules: [...contextAssembly.systemRules],
      agentId: args.identity.agentId,
      profileHash: args.identity.profileHash,
      profileRevision: args.identity.profileRevision,
      toolCatalogHash: args.toolCatalogHash,
      workspace: {
        workspaceId: session.workingDirectory?.id ?? session.workspaceId,
        rootName: snapshot?.rootName ?? session.workingDirectory?.name ?? 'workspace',
        providerKind: session.workingDirectory?.kind === 'browser_local' ? 'browser_broker' : 'server_local',
        revision
      }
    },
    l1: {
      sessionGoal: contextAssembly.sessionGoal,
      ...(contextAssembly.currentContractGoal
        ? { currentContractGoal: contextAssembly.currentContractGoal }
        : {}),
      phase: args.phase,
      ...(contextAssembly.currentTask
        ? {
            task: {
              id: contextAssembly.currentTask.id,
              title: contextAssembly.currentTask.title,
              description: contextAssembly.currentTask.description,
              acceptanceCriteria: [...contextAssembly.currentTask.acceptanceCriteria]
            }
          }
        : {}),
      navigation: buildNavigationManifest({ entries: index, entrypoints })
    },
    l2: buildProjectMap({ entries: index, entrypoints, detectedStack: snapshot?.detectedStack }),
    l3: {
      files: evidence.files,
      totalByteLength: evidence.totalByteLength,
      truncated:
        evidence.truncated ||
        (contextAssembly.selectedEvidenceContents?.some((item) => item.truncated === true) ?? false)
    },
    l5: {
      bullets: summaryBullets(contextAssembly),
      turnCount: contextAssembly.relevantEvents.length
    },
    l6: {
      changeSetIds: [],
      reportIds: contextAssembly.artifacts.map((artifact) => artifact.artifactId)
    },
    budget: {
      inputTokens,
      navigationTokens: Math.floor(inputTokens * 0.15),
      projectMapTokens: Math.floor(inputTokens * 0.1),
      evidenceTokens
    }
  });
}

function selectedEvidence(
  contextAssembly: ContextAssembly,
  evidenceTokenBudget: number,
  allowedPaths: ReadonlySet<string>
): ContextL3SelectedEvidence {
  const files = new Map<string, ContextL3EvidenceFile>();
  const candidates: ScoredEvidenceCandidate[] = [];
  for (const [index, item] of (contextAssembly.selectedEvidenceContents ?? []).entries()) {
    if (item.source !== 'workspace_file' || !item.content) continue;
    const path = item.ref?.trim() || item.label.trim();
    if (!path || files.has(path) || !allowedPaths.has(path)) continue;
    files.set(path, {
      path,
      content: item.content,
      byteLength: Buffer.byteLength(item.content, 'utf8')
    });
    candidates.push({
      path,
      score:
        10_000 - index +
        (item.selectionReason?.startsWith('Requested by runtime') ? 2_000 : 0) +
        (item.selectionReason?.startsWith('Architecture analysis priority') ? 1_000 : 0),
      reasons: [item.selectionReason ?? 'context-router-order']
    });
  }
  const budgetBytes = Math.max(0, evidenceTokenBudget * 4);
  const selected = selectEvidenceWithinBudget({ candidates, contents: files, budgetBytes });
  if (selected.files.length || !candidates.length || budgetBytes <= 0) return selected;

  const first = files.get(candidates[0]!.path)!;
  const content = truncateUtf8(first.content, budgetBytes);
  const file = { ...first, content, byteLength: Buffer.byteLength(content, 'utf8') };
  return {
    files: file.byteLength ? [file] : [],
    totalByteLength: file.byteLength,
    truncated: true
  };
}

function truncateUtf8(content: string, maxBytes: number) {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return content.slice(0, low);
}

function summaryBullets(contextAssembly: ContextAssembly): string[] {
  const memory = contextAssembly.summaryMemory;
  const selectedMemoryContents = (contextAssembly.selectedEvidenceContents ?? [])
    .filter((item) => item.source === 'memory' && Boolean(item.content?.trim()))
    .map((item) => item.content!.trim());
  const relevantMemoryContents = (contextAssembly.relevantMemories ?? [])
    .map((item) => item.content.trim())
    .filter(Boolean);
  const memoryBullets = [...new Set([...relevantMemoryContents, ...selectedMemoryContents])]
    .slice(0, 12)
    .map((content) => `Memory: ${truncateBullet(content)}`);
  return [
    memory.currentState,
    ...memoryBullets,
    ...memory.confirmedFacts,
    ...memory.completed,
    ...memory.decisions,
    ...memory.openQuestions.map((item) => `Open: ${item}`),
    ...memory.risks.map((item) => `Risk: ${item}`),
    ...memory.nextSteps.map((item) => `Next: ${item}`)
  ].filter(Boolean).slice(0, 40);
}

function truncateBullet(value: string, maxChars = 1_500) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function snapshotRevision(scannedAt: string | undefined, identity: string): WorkspaceRevision {
  return {
    id: `snapshot-${createHash('sha256').update(`${identity}:${scannedAt ?? 'unknown'}`).digest('hex').slice(0, 16)}`,
    observedAt: scannedAt ?? new Date(0).toISOString()
  };
}

function toContextPhase(phase: AgentRunPhase): ContextPhase {
  if (phase === 'task_acceptance' || phase === 'task_execution') return 'execution';
  if (phase === 'post_review') return 'post_review';
  if (phase === 'final_delivery') return 'delivery';
  return 'discussion';
}
