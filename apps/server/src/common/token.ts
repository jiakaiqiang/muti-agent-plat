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

export type ContextTrimStage = {
  name: 'initial' | 'focused' | 'compact' | 'minimal';
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
  const total = normalizeBudget(session.tokenBudget ?? Number(process.env.TOKEN_BUDGET_DEFAULT ?? 100_000));
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
  let next = contextPack;
  let estimatedTokens = estimateTokens(next);
  const stages: ContextTrimStage[] = [
    {
      name: 'initial',
      estimatedTokens,
      breakdown: contextTokenBreakdown(next)
    }
  ];
  let trimmed = false;

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
    workspaceTreeNodeLimit: 120
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
    workspaceTreeNodeLimit: 60
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
    workspaceTreeNodeLimit: 24
  });
  estimatedTokens = estimateTokens(next);
  stages.push({
    name: 'minimal',
    estimatedTokens,
    breakdown: contextTokenBreakdown(next)
  });
  return { contextPack: next, estimatedTokens, trimmed, diagnostics: buildDiagnostics(next, stages) };
}

type TrimOptions = {
  relevantEventCount: number;
  ragSnippetCount: number;
  artifactCount: number;
  workspaceContentFileCount: number;
  workspaceContentCharsPerFile: number;
  workspaceTotalContentChars: number;
  workspaceTreeNodeLimit: number;
};

function trimContext(contextPack: ContextPack, options: TrimOptions): ContextPack {
  return {
    ...contextPack,
    workspaceSnapshot: compactWorkspaceSnapshot(contextPack.workspaceSnapshot, contextPack.workspaceFocus?.relevantFiles ?? [], options),
    relevantEvents: options.relevantEventCount ? contextPack.relevantEvents.slice(-options.relevantEventCount) : [],
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
