import type { ContextPack, RuntimeBudget, SessionDetail, WorkspaceFileSnapshot, WorkspaceSnapshot } from '@agent-cluster/shared';

export function estimateTokens(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export function buildBudget(session: SessionDetail): RuntimeBudget {
  const total = normalizeBudget(session.tokenBudget ?? Number(process.env.TOKEN_BUDGET_DEFAULT ?? 100_000));
  return {
    maxInputTokens: Math.floor(total * 0.7),
    maxOutputTokens: Math.floor(total * 0.2),
    maxTotalTokens: total
  };
}

export function fitContextToBudget(contextPack: ContextPack): { contextPack: ContextPack; estimatedTokens: number; trimmed: boolean } {
  const maxInputTokens = contextPack.budget.maxInputTokens;
  let next = contextPack;
  let estimatedTokens = estimateTokens(next);
  let trimmed = false;

  if (!maxInputTokens || estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed };
  }

  next = trimContext(next, {
    relevantEventCount: 4,
    ragSnippetCount: 2,
    artifactCount: 3,
    workspaceContentFileCount: 6,
    workspaceContentCharsPerFile: 4_000,
    workspaceTotalContentChars: 14_000,
    workspaceTreeNodeLimit: 160
  });
  estimatedTokens = estimateTokens(next);
  trimmed = true;

  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed };
  }

  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 2,
    workspaceContentFileCount: 4,
    workspaceContentCharsPerFile: 1_200,
    workspaceTotalContentChars: 4_800,
    workspaceTreeNodeLimit: 80
  });
  estimatedTokens = estimateTokens(next);
  if (estimatedTokens <= maxInputTokens) {
    return { contextPack: next, estimatedTokens, trimmed };
  }

  next = trimContext(next, {
    relevantEventCount: 0,
    ragSnippetCount: 0,
    artifactCount: 1,
    workspaceContentFileCount: 0,
    workspaceContentCharsPerFile: 0,
    workspaceTotalContentChars: 0,
    workspaceTreeNodeLimit: 40
  });
  estimatedTokens = estimateTokens(next);
  return { contextPack: next, estimatedTokens, trimmed };
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
