import { createHash } from 'node:crypto';
import type {
  AgentRunPhase,
  CompiledAgentIdentity,
  ContextEnvelopeV2,
  ContextL3EvidenceFile,
  ContextL3SelectedEvidence,
  ContextAssembly,
  FileRevisionEvidence,
  SessionDetail,
  WorkspaceIndexEntry,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { buildIndexFromSnapshot } from '../workspaces/workspace-index/build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from '../workspaces/workspace-index/derive-workspace-entrypoints.js';
import { isGeneratedWorkspacePath } from '../workspaces/workspace-index/is-generated-workspace-path.js';
import { isSensitiveWorkspacePath } from '../workspaces/workspace-index/is-sensitive-workspace-path.js';
import { buildNavigationManifest } from './build-navigation-manifest.js';
import { buildProjectMap } from './build-project-map.js';
import { buildContextEnvelopeV2 } from './context-assembly-builder-v2.js';
import type { ContextBundleCache } from './context-bundle-cache.js';
import type { ContextPhase } from './phase-context-policy.js';
import { selectEvidenceWithinBudget } from './select-evidence-within-budget.js';
import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';
import { assertL0SystemRuleTrustBoundary } from './l0-trust-boundary.js';
import { workspaceProviderKindForDirectory } from '../workspaces/workspace-provider.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';

const DEFAULT_INPUT_TOKENS = 32_000;

/** Convert the internal assembly into the only Runtime context contract. */
export function buildEnvelopeFromContextAssembly(args: {
  session: SessionDetail;
  phase: AgentRunPhase;
  contextAssembly: ContextAssembly;
  identity: CompiledAgentIdentity;
  toolCatalogHash: string;
  /**
   * Optional derived-bundle cache. Only the workspace-derived layers (navigation,
   * project map) go through it; evidence and summary are always rebuilt. Absent
   * means every call builds from scratch, which is the pre-2C behaviour.
   */
  cache?: { bundles: ContextBundleCache; generation: number };
}): ContextEnvelopeV2 {
  const { session, contextAssembly } = args;
  const snapshot = session.workspaceSnapshot;
  const providerIndex = session.workspaceIndex;
  const revision = providerIndex?.revision ?? session.workspaceContext?.indexRevision ?? snapshot?.revision ?? snapshotRevision(snapshot?.scannedAt, snapshot?.rootName ?? session.workspaceId);
  const sourceIndex = providerIndex
    ? providerIndex.entries.map((entry): WorkspaceIndexEntry => entry.kind === 'file'
      ? { ...entry, kind: 'file', size: entry.size ?? 0, revision }
      : { ...entry, kind: 'directory', revision })
    : snapshot
      ? buildIndexFromSnapshot(snapshot, revision)
      : [];
  const revisionEntries = contextAssembly.fileRevisionEvidence ?? [];
  const index = includeFileRevisionNavigationEntries(sourceIndex, revisionEntries, revision);
  const sourceEntrypoints = providerIndex?.entrypoints ?? (snapshot ? deriveWorkspaceEntrypoints(snapshot, index) : []);
  const entrypoints = [...new Set([
    ...sourceEntrypoints,
    ...revisionEntries.map((item) => item.filePath)
  ])];
  const inputTokens = contextAssembly.budget.maxInputTokens ?? session.tokenBudget ?? DEFAULT_INPUT_TOKENS;
  const evidenceTokens = Math.floor(inputTokens * 0.4);
  const allowedEvidencePaths = new Set(
    index
      .filter((entry) => entry.kind === 'file' && !entry.generated && !entry.sensitive)
      .map((entry) => entry.path)
  );
  const hydratedSupplementalPaths = new Set(
    (session.supplementalContextRequests ?? []).flatMap((request) =>
      request.resolution.hydratedPaths.filter((path) =>
        !providerIndex || request.resolution.evidenceRevisions?.[path]?.id === revision.id
      )
    )
  );
  for (const item of contextAssembly.selectedEvidenceContents ?? []) {
    const path = item.ref?.trim() || item.label.trim();
    if (item.source === 'workspace_file' && item.content && hydratedSupplementalPaths.has(path)) {
      allowedEvidencePaths.add(path);
    }
  }
  const hasFileRevisionEvidence = Boolean(contextAssembly.fileRevisionEvidence?.length);
  const workspaceEvidenceTokens = hasFileRevisionEvidence ? Math.floor(evidenceTokens * 0.2) : evidenceTokens;
  const evidence = selectedEvidence(
    contextAssembly,
    workspaceEvidenceTokens,
    allowedEvidencePaths,
    providerIndex ? revision : undefined
  );
  const fileRevisionBudgetBytes = Math.max(0, (evidenceTokens - workspaceEvidenceTokens) * 4);
  const revisionEvidence = selectedFileRevisionEvidence(contextAssembly, fileRevisionBudgetBytes);

  const detectedStack = Array.from(new Set([
    ...(providerIndex?.detectedStack ?? []),
    ...(snapshot?.detectedStack ?? [])
  ]));
  const buildBundle = () => ({
    navigation: {
      ...buildNavigationManifest({
        entries: index,
        entrypoints,
        budgetTokens: Math.floor(inputTokens * 0.15)
      }),
      ...(providerIndex
        ? {
            indexGeneration: providerIndex.generation,
            indexStatus: providerIndex.status,
            indexComplete: providerIndex.complete,
            indexRevision: providerIndex.revision
          }
        : {})
    },
    projectMap: buildProjectMap({
      entries: index,
      entrypoints,
      detectedStack,
      budgetTokens: Math.floor(inputTokens * 0.1)
    })
  });
  const bundle = args.cache
    ? args.cache.bundles.getOrBuild({
        scope: {
          sessionId: session.id,
          // Navigation is workspace-derived, not requirement-derived, but the
          // private key contract still partitions by requirement and role.
          // Over-scoping costs hit rate; under-scoping would be a leak.
          workItemId: contextAssembly.workItemId ?? '-',
          agentId: args.identity.agentId,
          generation: args.cache.generation
        },
        dependencyFingerprint: bundleFingerprint({
          revisionId: revision.id,
          inputTokens,
          entrypoints,
          detectedStack,
          providerIndexState: providerIndex
            ? { generation: providerIndex.generation, status: providerIndex.status, complete: providerIndex.complete }
            : undefined
        }),
        build: buildBundle
      })
    : buildBundle();

  const built = buildContextEnvelopeV2({
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
        providerKind: workspaceProviderKindForDirectory(session.workingDirectory?.kind),
        revision
      }
    },
    l1: {
      sessionGoal: contextAssembly.sessionGoal,
      ...(contextAssembly.attachmentRefs?.length
        ? { attachmentRefs: contextAssembly.attachmentRefs.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(contextAssembly.currentContractGoal
        ? { currentContractGoal: contextAssembly.currentContractGoal }
        : {}),
      ...(args.phase === 'user_message_routing' && contextAssembly.currentUserMessage !== undefined
        ? { currentUserMessage: contextAssembly.currentUserMessage }
        : {}),
      ...(contextAssembly.requiredDocument ? { requiredDocument: contextAssembly.requiredDocument } : {}),
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
      navigation: bundle.navigation
    },
    l2: bundle.projectMap,
    l3: {
      files: evidence.files,
      fileRevisions: revisionEvidence.items,
      totalByteLength: evidence.totalByteLength + revisionEvidence.totalByteLength,
      truncated:
        evidence.truncated ||
        revisionEvidence.truncated ||
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
  assertL0SystemRuleTrustBoundary(built);
  return {
    ...built,
    contextScope: {
      ...(contextAssembly.workItemId ? { workItemId: contextAssembly.workItemId } : {}),
      ...(contextAssembly.contextSnapshotId ? { contextSnapshotId: contextAssembly.contextSnapshotId } : {}),
      ...(contextAssembly.decisionSetHash ? { decisionSetHash: contextAssembly.decisionSetHash } : {}),
      inheritedDecisionIds: [...(contextAssembly.inheritedDecisionIds ?? [])],
      inheritedArtifactIds: [...(contextAssembly.inheritedArtifactIds ?? [])]
    }
  };
}

function includeFileRevisionNavigationEntries(
  source: WorkspaceIndexEntry[],
  revisions: FileRevisionEvidence[],
  revision: WorkspaceRevision
): WorkspaceIndexEntry[] {
  if (revisions.length === 0) return source;
  const entries = [...source];
  const existingPaths = new Set(entries.map((entry) => entry.path));
  for (const evidence of revisions) {
    const path = evidence.filePath;
    if (!path || existingPaths.has(path)) continue;
    entries.push({
      path,
      kind: 'file',
      size: evidence.userDraft.byteLength,
      revision,
      generated: isGeneratedWorkspacePath(path),
      sensitive: isSensitiveWorkspacePath(path)
    });
    existingPaths.add(path);
  }
  return entries;
}

function selectedFileRevisionEvidence(
  contextAssembly: ContextAssembly,
  budgetBytes: number
): { items: FileRevisionEvidence[]; totalByteLength: number; truncated: boolean } {
  const source = contextAssembly.fileRevisionEvidence ?? [];
  if (source.length === 0) return { items: [], totalByteLength: 0, truncated: false };
  if (source.some((item) => item.complete !== true || item.truncated !== false)) {
    workspaceMetrics.increment('file_revision_context_incomplete_total', 1, { phase: 'context_compile' });
    throw new Error('REVISION_CONTEXT_INCOMPLETE: revision evidence must never be truncated.');
  }
  const totalByteLength = Buffer.byteLength(JSON.stringify(source), 'utf8');
  if (totalByteLength > budgetBytes) {
    workspaceMetrics.increment('file_revision_model_capacity_rejected_total', 1, { phase: 'context_compile' });
    throw new Error(
      `REVISION_MODEL_CAPACITY_INSUFFICIENT: complete revision evidence needs ${totalByteLength} bytes, budget is ${budgetBytes}.`
    );
  }
  return { items: source, totalByteLength, truncated: false };
}

function selectedEvidence(
  contextAssembly: ContextAssembly,
  evidenceTokenBudget: number,
  allowedPaths: ReadonlySet<string>,
  requiredRevision?: WorkspaceRevision
): ContextL3SelectedEvidence {
  const files = new Map<string, ContextL3EvidenceFile>();
  const candidates: ScoredEvidenceCandidate[] = [];
  for (const [index, item] of (contextAssembly.selectedEvidenceContents ?? []).entries()) {
    if (item.source !== 'workspace_file' || !item.content) continue;
    const path = item.ref?.trim() || item.label.trim();
    if (
      !path ||
      files.has(path) ||
      !allowedPaths.has(path) ||
      (requiredRevision && item.revision?.id !== requiredRevision.id)
    ) continue;
    files.set(path, {
      path,
      content: item.content,
      byteLength: Buffer.byteLength(item.content, 'utf8'),
      ...(item.hash ? { hash: item.hash } : {}),
      ...(item.revision ? { revision: item.revision } : {}),
      ...(item.startLine ? { startLine: item.startLine } : {}),
      ...(item.endLine ? { endLine: item.endLine } : {})
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
  const selectedArtifactContents = (contextAssembly.selectedEvidenceContents ?? [])
    .filter((item) => item.source === 'artifact' && Boolean((item.content ?? item.summary)?.trim()))
    .slice(0, 6)
    .map((item) => `Artifact ${item.label}: ${truncateBullet((item.content ?? item.summary)!.trim())}`);
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
    ...selectedArtifactContents,
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

/**
 * Everything the navigation/project-map bundle is built from, and nothing else.
 * The workspace revision id already stands for the whole tree state, so file
 * paths are not repeated here; the remaining inputs are the ones that change
 * the bundle's shape without changing the revision (budget, extra entrypoints
 * from revision evidence, index readiness). Per-call evidence is deliberately
 * absent because it never enters the bundle.
 */
function bundleFingerprint(input: {
  revisionId: string;
  inputTokens: number;
  entrypoints: string[];
  detectedStack: string[];
  providerIndexState: { generation: number; status: string; complete: boolean } | undefined;
}): string {
  return JSON.stringify({
    revisionId: input.revisionId,
    inputTokens: input.inputTokens,
    entrypoints: [...input.entrypoints].sort(),
    detectedStack: [...input.detectedStack].sort(),
    providerIndexState: input.providerIndexState ?? null
  });
}

function toContextPhase(phase: AgentRunPhase): ContextPhase {
  if (phase === 'task_acceptance' || phase === 'task_execution' || phase === 'revision_synthesis') return 'execution';
  if (phase === 'post_review') return 'post_review';
  if (phase === 'final_delivery') return 'delivery';
  return 'discussion';
}
