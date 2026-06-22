import type { ContextPack, RuntimeBudget, SessionDetail, WorkspaceFileSnapshot, WorkspaceSnapshot } from '@agent-cluster/shared';

export function estimateTokens(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export type ContextTokenBreakdown = {
  systemRules: number;
  sessionGoal: number;
  taskContext: number;
  summaryMemory: number;
  continuationState: number;
  workingDirectory: number;
  workspaceSnapshot: number;
  workspaceManifest: number;
  selectedEvidenceContents: number;
  projectMap: number;
  workspaceFocus: number;
  taskBrief: number;
  currentTask: number;
  agentProfile: number;
  relevantEvents: number;
  relevantMemories: number;
  ragSnippets: number;
  artifacts: number;
  capabilities: number;
  constraints: number;
  budget: number;
  total: number;
};

const MAX_PROJECT_MAP_MODULES = 8;
const MAX_PROJECT_MAP_ITEMS_PER_MODULE = 5;
const MAX_WORKSPACE_FOCUS_ITEMS = 12;
const MAX_TASK_MAP_ITEMS = 12;
const MAX_STAGE_PLAN_ITEMS = 8;
const MAX_EVIDENCE_REFS = 20;
const MAX_SELECTED_EVIDENCE_ITEMS = 3;

export type ContextTrimStage = {
  name: 'initial' | 'focused' | 'compact' | 'minimal' | 'ultra-minimal' | 'emergency';
  estimatedTokens: number;
  breakdown: ContextTokenBreakdown;
};

export type ContextBudgetDiagnostics = {
  stages: ContextTrimStage[];
  dominantSections: Array<{ key: keyof ContextTokenBreakdown; tokens: number }>;
  workspaceFileCount: number;
  workspaceTreeCount: number;
  relevantEventCount: number;
  artifactCount: number;
  ragSnippetCount: number;
  memoryCount: number;
};

export function buildBudget(session: SessionDetail): RuntimeBudget {
  // Keep a high default for remote models and cap it per runtime before execution.
  const defaultBudget = Number(process.env.TOKEN_BUDGET_DEFAULT ?? 200_000);
  const total = normalizeBudget(session.tokenBudget ?? defaultBudget);
  return {
    maxInputTokens: Math.floor(total * 0.7),
    maxOutputTokens: Math.floor(total * 0.2),
    maxTotalTokens: total
  };
}

export function fitContextToBudget(contextPack: ContextPack): {
  contextPack: ContextPack;
  estimatedTokens: number;
  trimmed: boolean;
  diagnostics: ContextBudgetDiagnostics;
} {
  const maxInputTokens = contextPack.budget.maxInputTokens;
  let next = trimContext(contextPack, {
    relevantEventCount: 12,
    ragSnippetCount: 6,
    artifactCount: 6,
    workspaceContentFileCount: 8,
    workspaceContentCharsPerFile: 4_000,
    workspaceTotalContentChars: 16_000,
    workspaceTreeNodeLimit: 240,
    workspaceManifestFileLimit: 80,
    selectedEvidenceItemLimit: MAX_SELECTED_EVIDENCE_ITEMS,
    selectedEvidenceTotalChars: 16_000,
    projectMapModuleLimit: MAX_PROJECT_MAP_MODULES,
    workspaceFocusItemLimit: MAX_WORKSPACE_FOCUS_ITEMS,
    evidenceRefLimit: MAX_EVIDENCE_REFS
  });
  let estimatedTokens = estimateTokens(next);
  const stages: ContextTrimStage[] = [
    {
      name: 'initial',
      estimatedTokens,
      breakdown: contextTokenBreakdown(next)
    }
  ];
  let trimmed = estimatedTokens !== estimateTokens(contextPack);

  if (!maxInputTokens || estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
  }

  next = trimContext(next, {
    relevantEventCount: 6,
    ragSnippetCount: 3,
    artifactCount: 3,
    workspaceContentFileCount: 5,
    workspaceContentCharsPerFile: 2_400,
    workspaceTotalContentChars: 8_000,
    workspaceTreeNodeLimit: 120,
    workspaceManifestFileLimit: 40,
    selectedEvidenceItemLimit: 6,
    selectedEvidenceTotalChars: 8_000,
    projectMapModuleLimit: 6,
    workspaceFocusItemLimit: 10,
    evidenceRefLimit: 16
  });
  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'focused',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });
  trimmed = true;

  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
  }

  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 2,
    workspaceContentFileCount: 2,
    workspaceContentCharsPerFile: 600,
    workspaceTotalContentChars: 1_200,
    workspaceTreeNodeLimit: 60,
    workspaceManifestFileLimit: 20,
    selectedEvidenceItemLimit: 3,
    selectedEvidenceTotalChars: 1_200,
    projectMapModuleLimit: 4,
    workspaceFocusItemLimit: 6,
    evidenceRefLimit: 10
  });
  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'compact',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });
  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
  }

  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 0,
    workspaceContentFileCount: 0,
    workspaceContentCharsPerFile: 0,
    workspaceTotalContentChars: 0,
    workspaceTreeNodeLimit: 24,
    workspaceManifestFileLimit: 8,
    selectedEvidenceItemLimit: 0,
    selectedEvidenceTotalChars: 0,
    projectMapModuleLimit: 2,
    workspaceFocusItemLimit: 4,
    evidenceRefLimit: 6
  });
  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'minimal',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });
  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
  }

  // Stage 5: ultra-minimal.
  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 0,
    workspaceContentFileCount: 0,
    workspaceContentCharsPerFile: 0,
    workspaceTotalContentChars: 0,
    workspaceTreeNodeLimit: 5,
    workspaceManifestFileLimit: 0,
    selectedEvidenceItemLimit: 0,
    selectedEvidenceTotalChars: 0,
    projectMapModuleLimit: 1,
    workspaceFocusItemLimit: 2,
    evidenceRefLimit: 2
  });
  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'ultra-minimal',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });
  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
  }

  // Stage 6: emergency - 搴旀€ユā寮忥紝鍙繚鐣欐渶鏍稿績淇℃伅
  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 0,
    workspaceContentFileCount: 0,
    workspaceContentCharsPerFile: 0,
    workspaceTotalContentChars: 0,
    workspaceTreeNodeLimit: 0,
    workspaceManifestFileLimit: 0,
    selectedEvidenceItemLimit: 0,
    selectedEvidenceTotalChars: 0,
    projectMapModuleLimit: 0,
    workspaceFocusItemLimit: 0,
    evidenceRefLimit: 0
  });

  // 寮哄埗娓呯┖澶у瀷缁撴瀯
  next = {
    ...next,
    workspaceSnapshot: next.workspaceSnapshot ? {
      rootName: next.workspaceSnapshot.rootName,
      scannedAt: next.workspaceSnapshot.scannedAt,
      fileCount: next.workspaceSnapshot.fileCount,
      totalBytes: next.workspaceSnapshot.totalBytes,
      tree: [],
      files: [],
      skipped: [],
      entrypoints: next.workspaceSnapshot.entrypoints?.slice(0, 2)
    } : undefined,
    workspaceFocus: next.workspaceFocus ? {
      relevantFiles: next.workspaceFocus.relevantFiles.slice(0, 3),
      impactedFiles: [],
      testFiles: [],
      configFiles: [],
      possibleEntryPoints: [],
      detectedStack: next.workspaceFocus.detectedStack.slice(0, 2),
      validationCommands: [],
      rationale: 'Emergency mode: context severely limited due to token budget. Workspace has ' +
                 (next.workspaceSnapshot?.fileCount || 0) + ' files.'
    } : undefined,
    projectMap: undefined,
    workspaceManifest: undefined
  };

  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'emergency',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });

  return { contextPack: next, estimatedTokens, trimmed: true, diagnostics: buildDiagnostics(next, stages) };
}

type TrimOptions = {
  relevantEventCount: number;
  ragSnippetCount: number;
  artifactCount: number;
  workspaceContentFileCount: number;
  workspaceContentCharsPerFile: number;
  workspaceTotalContentChars: number;
  workspaceTreeNodeLimit: number;
  workspaceManifestFileLimit: number;
  selectedEvidenceItemLimit: number;
  selectedEvidenceTotalChars: number;
  projectMapModuleLimit: number;
  workspaceFocusItemLimit: number;
  evidenceRefLimit: number;
};

function trimContext(contextPack: ContextPack, options: TrimOptions): ContextPack {
  const workspaceFocus = compactWorkspaceFocus(contextPack.workspaceFocus, options.workspaceFocusItemLimit);
  return {
    ...contextPack,
    taskContext: compactTaskContext(contextPack.taskContext, options.evidenceRefLimit),
    continuationState: compactContinuationState(contextPack.continuationState),
    workspaceSnapshot: compactWorkspaceSnapshot(contextPack.workspaceSnapshot, workspaceFocus?.relevantFiles ?? [], options),
    workspaceManifest: compactWorkspaceManifest(contextPack.workspaceManifest, workspaceFocus?.relevantFiles ?? [], options),
    selectedEvidenceContents: compactSelectedEvidenceContents(contextPack.selectedEvidenceContents, options),
    projectMap: compactProjectMap(contextPack.projectMap, options.projectMapModuleLimit),
    workspaceFocus,
    relevantEvents: options.relevantEventCount ? contextPack.relevantEvents.slice(-options.relevantEventCount) : [],
    relevantMemories: contextPack.relevantMemories.slice(-Math.max(2, options.selectedEvidenceItemLimit)),
    ragSnippets: contextPack.ragSnippets.slice(0, options.ragSnippetCount),
    artifacts: contextPack.artifacts.slice(-options.artifactCount)
  };
}

function compactWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot | undefined,
  relevantFiles: string[],
  options: TrimOptions
): WorkspaceSnapshot | undefined {
  if (!snapshot) return undefined;

  const relevant = new Set(relevantFiles);
  let remainingContentChars = options.workspaceTotalContentChars;
  let contentFileCount = 0;
  const rankedFiles = [...snapshot.files].sort((left, right) => fileRank(right, relevant) - fileRank(left, relevant));
  const files = rankedFiles.map((file) => {
    const keepContent =
      Boolean(file.content) &&
      remainingContentChars > 0 &&
      contentFileCount < options.workspaceContentFileCount &&
      (relevant.has(file.path) || contentFileCount === 0);

    if (!keepContent) {
      return fileWithoutContent(file);
    }

    const content = String(file.content).slice(0, Math.min(options.workspaceContentCharsPerFile, remainingContentChars));
    remainingContentChars -= content.length;
    contentFileCount += 1;
    return {
      ...file,
      content,
      summary: file.content && file.content.length > content.length ? `Content truncated to ${content.length} characters.` : file.summary
    };
  });

  return {
    ...snapshot,
    tree: compactTree(snapshot.tree, options.workspaceTreeNodeLimit),
    files
  };
}

function fileRank(file: WorkspaceFileSnapshot, relevantFiles: Set<string>) {
  const fileName = file.path.toLowerCase().split('/').at(-1) ?? file.path.toLowerCase();
  let score = 0;
  if (relevantFiles.has(file.path)) score += 100;
  if (['agents.md', 'claude.md', 'readme.md', 'package.json', 'tsconfig.json'].includes(fileName)) score += 20;
  if (file.path.startsWith('src/') || file.path.startsWith('apps/') || file.path.startsWith('packages/')) score += 5;
  return score;
}

function fileWithoutContent(file: WorkspaceFileSnapshot): WorkspaceFileSnapshot {
  const contentLength = file.content?.length ?? 0;
  const { content: _content, ...rest } = file;
  return {
    ...rest,
    summary: file.summary ?? (contentLength ? `Content omitted from runtime context; ${contentLength} characters available in snapshot.` : undefined)
  };
}

function compactTree(tree: WorkspaceSnapshot['tree'], limit: number) {
  if (tree.length <= limit) return tree;
  const compacted = tree.slice(0, limit);
  compacted.push({
    path: `... ${tree.length - limit} more workspace entries omitted from runtime context`,
    kind: 'file'
  });
  return compacted;
}

function compactWorkspaceManifest(
  manifest: ContextPack['workspaceManifest'] | undefined,
  relevantFiles: string[],
  options: TrimOptions
): ContextPack['workspaceManifest'] | undefined {
  if (!manifest) return undefined;
  const relevant = new Set(relevantFiles);
  const rankedFiles = [...manifest.files]
    .sort((left, right) => manifestFileRank(right, relevant) - manifestFileRank(left, relevant))
    .slice(0, options.workspaceManifestFileLimit)
    .map((file) => ({ ...file }));
  return {
    ...manifest,
    tree: compactTree(manifest.tree, options.workspaceTreeNodeLimit),
    files: rankedFiles
  };
}

function manifestFileRank(file: ContextPack['workspaceManifest'] extends undefined ? never : NonNullable<ContextPack['workspaceManifest']>['files'][number], relevantFiles: Set<string>) {
  const fileName = file.path.toLowerCase().split('/').at(-1) ?? file.path.toLowerCase();
  let score = 0;
  if (relevantFiles.has(file.path)) score += 100;
  if (['agents.md', 'claude.md', 'readme.md', 'package.json', 'tsconfig.json'].includes(fileName)) score += 20;
  if (file.path.startsWith('src/') || file.path.startsWith('apps/') || file.path.startsWith('packages/')) score += 5;
  score += Math.min(10, Math.ceil((file.contentLength ?? 0) / 10_000));
  return score;
}

function compactSelectedEvidenceContents(
  contents: ContextPack['selectedEvidenceContents'] | undefined,
  options: TrimOptions
): ContextPack['selectedEvidenceContents'] | undefined {
  if (!contents?.length) return contents;
  let remainingChars = options.selectedEvidenceTotalChars;
  return uniqueSelectedEvidenceContents(contents)
    .slice(0, options.selectedEvidenceItemLimit)
    .map((item) => {
    if (!item.content || remainingChars <= 0) {
      const { content: _content, ...rest } = item;
      return {
        ...rest,
        truncated: Boolean(item.content) || item.truncated,
        summary: rest.summary ?? (item.content ? 'Selected evidence content omitted by token budget.' : rest.summary)
      };
    }
    const maxChars = Math.min(options.workspaceContentCharsPerFile, remainingChars);
    const content = item.content.slice(0, maxChars);
    remainingChars -= content.length;
    return {
      ...item,
      content,
      truncated: item.truncated || item.content.length > content.length,
      summary:
        item.summary ??
        (item.content.length > content.length ? `Selected evidence content truncated to ${content.length} characters.` : undefined),
      tokenEstimate: Math.max(1, Math.ceil(JSON.stringify({ ...item, content }).length / 4))
    };
  });
}

function uniqueSelectedEvidenceContents(
  contents: NonNullable<ContextPack['selectedEvidenceContents']>
): NonNullable<ContextPack['selectedEvidenceContents']> {
  const selected = new Map<string, NonNullable<ContextPack['selectedEvidenceContents']>[number]>();
  for (const item of contents) {
    const key = selectedEvidenceContentKey(item);
    const previous = selected.get(key);
    if (!previous || selectedEvidenceContentRank(item) > selectedEvidenceContentRank(previous)) {
      selected.set(key, item);
    }
  }
  return Array.from(selected.values()).sort((left, right) => selectedEvidenceContentRank(right) - selectedEvidenceContentRank(left));
}

function selectedEvidenceContentKey(item: NonNullable<ContextPack['selectedEvidenceContents']>[number]) {
  const ref = normalizeEvidenceRef(item.ref);
  if (item.source === 'workspace_file' && ref) return `workspace_file:${ref}`;
  if ((item.source === 'artifact' || item.type === 'diff') && ref) return `artifact:${ref}`;
  if (item.source === 'workspace_manifest') return 'workspace_manifest';
  if (item.source === 'project_map') return `project_map:${item.label}`;
  if (ref) return `${item.source}:${ref}`;
  return `${item.source}:${item.type}:${item.label}`;
}

function normalizeEvidenceRef(value: string | undefined) {
  return value?.trim().replace(/\\/g, '/').toLowerCase();
}

function selectedEvidenceContentRank(item: NonNullable<ContextPack['selectedEvidenceContents']>[number]) {
  let score = 0;
  if (item.selectionReason?.startsWith('Requested by runtime')) score += 1_000;
  if (item.content) score += 100;
  if (item.source === 'workspace_file') score += 40;
  if (item.source === 'artifact') score += 30;
  if (item.source === 'memory' || item.source === 'rag') score += 20;
  if (item.source === 'project_map' || item.source === 'workspace_manifest') score += 5;
  score += Math.min(20, Math.ceil((item.contentLength ?? item.content?.length ?? 0) / 1_000));
  return score;
}

function compactProjectMap(projectMap: ContextPack['projectMap'] | undefined, moduleLimit: number): ContextPack['projectMap'] | undefined {
  if (!projectMap) return undefined;
  return {
    ...projectMap,
    modules: projectMap.modules.slice(0, moduleLimit).map((module) => ({
      ...module,
      entrypoints: module.entrypoints.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
      contracts: module.contracts.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
      tests: module.tests.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
      commonTasks: module.commonTasks.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE)
    })),
    validationCommands: projectMap.validationCommands.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
    riskBoundaries: projectMap.riskBoundaries.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
    memoryLocations: projectMap.memoryLocations.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE),
    sourceRefs: projectMap.sourceRefs.slice(0, MAX_PROJECT_MAP_ITEMS_PER_MODULE)
  };
}

function compactWorkspaceFocus(
  focus: ContextPack['workspaceFocus'] | undefined,
  itemLimit: number
): ContextPack['workspaceFocus'] | undefined {
  if (!focus) return undefined;
  return {
    ...focus,
    relevantFiles: focus.relevantFiles.slice(0, itemLimit),
    impactedFiles: focus.impactedFiles.slice(0, itemLimit),
    testFiles: focus.testFiles.slice(0, itemLimit),
    configFiles: focus.configFiles.slice(0, itemLimit),
    possibleEntryPoints: focus.possibleEntryPoints.slice(0, itemLimit),
    detectedStack: focus.detectedStack.slice(0, itemLimit),
    validationCommands: focus.validationCommands.slice(0, Math.min(itemLimit, 8))
  };
}

function compactTaskContext(taskContext: ContextPack['taskContext'], evidenceRefLimit: number): ContextPack['taskContext'] {
  const selectedRefs = taskContext.evidenceSelection.selectedRefs.slice(0, evidenceRefLimit);
  const omittedRefs = taskContext.evidenceSelection.omittedRefs.slice(0, Math.min(evidenceRefLimit, 8));
  return {
    ...taskContext,
    taskMap: {
      ...taskContext.taskMap,
      items: taskContext.taskMap.items.slice(0, MAX_TASK_MAP_ITEMS)
    },
    stagePlan: {
      ...taskContext.stagePlan,
      read: taskContext.stagePlan.read.slice(0, MAX_STAGE_PLAN_ITEMS),
      do: taskContext.stagePlan.do.slice(0, MAX_STAGE_PLAN_ITEMS),
      validate: taskContext.stagePlan.validate.slice(0, MAX_STAGE_PLAN_ITEMS)
    },
    evidenceSelection: {
      ...taskContext.evidenceSelection,
      selectedRefs,
      omittedRefs,
      selectedCount: selectedRefs.length,
      omittedCount: Math.min(taskContext.evidenceSelection.omittedCount, omittedRefs.length),
      selectedTypes: [...new Set(selectedRefs.map((ref) => ref.type))],
      omittedTypes: [...new Set(omittedRefs.map((ref) => ref.type))]
    },
    evidenceRefs: taskContext.evidenceRefs.slice(0, evidenceRefLimit)
  };
}

function compactContinuationState(state: ContextPack['continuationState']): ContextPack['continuationState'] {
  return {
    ...state,
    pendingTaskIds: state.pendingTaskIds.slice(0, 12),
    runningTaskIds: state.runningTaskIds.slice(0, 12),
    completedTaskIds: state.completedTaskIds.slice(-12),
    blockedTaskIds: state.blockedTaskIds.slice(0, 12),
    nextAgentKeys: state.nextAgentKeys.slice(0, 8),
    handoffRefs: state.handoffRefs.slice(-8),
    sourceEventIds: state.sourceEventIds.slice(-8),
    sourceArtifactIds: state.sourceArtifactIds.slice(-8),
    resumeHints: state.resumeHints.slice(0, 8)
  };
}

function normalizeBudget(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100_000;
}

function contextTokenBreakdown(contextPack: ContextPack): ContextTokenBreakdown {
  const breakdown = {
    systemRules: estimateTokens(contextPack.systemRules),
    sessionGoal: estimateTokens(contextPack.sessionGoal),
    taskContext: estimateTokens(contextPack.taskContext),
    summaryMemory: estimateTokens(contextPack.summaryMemory),
    continuationState: estimateTokens(contextPack.continuationState),
    workingDirectory: estimateTokens(contextPack.workingDirectory),
    workspaceSnapshot: estimateTokens(contextPack.workspaceSnapshot),
    workspaceManifest: estimateTokens(contextPack.workspaceManifest),
    selectedEvidenceContents: estimateTokens(contextPack.selectedEvidenceContents),
    projectMap: estimateTokens(contextPack.projectMap),
    workspaceFocus: estimateTokens(contextPack.workspaceFocus),
    taskBrief: estimateTokens(contextPack.taskBrief),
    currentTask: estimateTokens(contextPack.currentTask),
    agentProfile: estimateTokens(contextPack.agentProfile),
    relevantEvents: estimateTokens(contextPack.relevantEvents),
    relevantMemories: estimateTokens(contextPack.relevantMemories),
    ragSnippets: estimateTokens(contextPack.ragSnippets),
    artifacts: estimateTokens(contextPack.artifacts),
    capabilities: estimateTokens(contextPack.capabilities),
    constraints: estimateTokens(contextPack.constraints),
    budget: estimateTokens(contextPack.budget),
    total: 0
  } satisfies ContextTokenBreakdown;
  breakdown.total =
    breakdown.systemRules +
    breakdown.sessionGoal +
    breakdown.taskContext +
    breakdown.summaryMemory +
    breakdown.continuationState +
    breakdown.workingDirectory +
    breakdown.workspaceSnapshot +
    breakdown.workspaceManifest +
    breakdown.selectedEvidenceContents +
    breakdown.projectMap +
    breakdown.workspaceFocus +
    breakdown.taskBrief +
    breakdown.currentTask +
    breakdown.agentProfile +
    breakdown.relevantEvents +
    breakdown.relevantMemories +
    breakdown.ragSnippets +
    breakdown.artifacts +
    breakdown.capabilities +
    breakdown.constraints +
    breakdown.budget;
  return breakdown;
}

function buildDiagnostics(contextPack: ContextPack, stages: ContextTrimStage[]): ContextBudgetDiagnostics {
  const latest = stages.at(-1)?.breakdown ?? contextTokenBreakdown(contextPack);
  return {
    stages,
    dominantSections: Object.entries(latest)
      .filter(([key]) => key !== 'total')
      .map(([key, tokens]) => ({ key: key as keyof ContextTokenBreakdown, tokens }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 5),
    workspaceFileCount: contextPack.workspaceSnapshot?.files.length ?? 0,
    workspaceTreeCount: contextPack.workspaceSnapshot?.tree.length ?? 0,
    relevantEventCount: contextPack.relevantEvents.length,
    artifactCount: contextPack.artifacts.length,
    ragSnippetCount: contextPack.ragSnippets.length,
    memoryCount: contextPack.relevantMemories.length
  };
}
