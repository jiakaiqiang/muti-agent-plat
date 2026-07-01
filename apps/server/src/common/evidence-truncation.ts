import type { EvidenceTruncatedHint, EvidenceTruncationStrategy } from '@agent-cluster/shared';

export type { EvidenceTruncatedHint, EvidenceTruncationStrategy };

export type EvidenceTruncationResult = {
  content: string;
  truncated: boolean;
  truncatedHint?: EvidenceTruncatedHint;
};

const tsLikeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue']);
const mdLikeExtensions = new Set(['.md', '.markdown', '.mdx']);

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function sliceResult(content: string, budget: number): EvidenceTruncationResult {
  const originalBytes = content.length;
  const effectiveBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  if (effectiveBudget >= originalBytes) {
    return { content, truncated: false };
  }
  const kept = effectiveBudget === 0 ? '' : content.slice(0, effectiveBudget);
  return {
    content: kept,
    truncated: true,
    truncatedHint: {
      strategy: 'slice',
      originalBytes,
      keptBytes: kept.length,
      droppedRanges: kept.length < originalBytes ? [[kept.length, originalBytes - 1]] : undefined
    }
  };
}

/**
 * Best-effort import/export block at the top of a TS/JS file. Stops at the
 * first non-import/export/blank/comment line so we do not pull function
 * bodies into the "header" that would otherwise blow the budget.
 */
function topHeaderRegion(content: string): string {
  const lines = content.split('\n');
  let lastIncludedIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    if (/^import\b/.test(line) || /^export\s+(type|interface)\b/.test(line) || /^export\s+\*/.test(line)) {
      lastIncludedIndex = i;
      continue;
    }
    if (/^export\s+\{/.test(line)) {
      lastIncludedIndex = i;
      continue;
    }
    break;
  }
  if (lastIncludedIndex < 0) return '';
  return lines.slice(0, lastIncludedIndex + 1).join('\n') + '\n';
}

/**
 * Finds the start line of the symbol declaration whose body contains the
 * query. Returns undefined if no symbol covers the query offset.
 */
function locateContainingSymbolStart(content: string, queryOffset: number): number | undefined {
  const symbolRegex = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+\w+/gm;
  let lastBefore: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = symbolRegex.exec(content)) !== null) {
    if (match.index <= queryOffset) {
      lastBefore = match.index;
    } else {
      break;
    }
  }
  return lastBefore;
}

function tsSymbolWindow(
  content: string,
  budget: number,
  query: string
): EvidenceTruncationResult | undefined {
  const queryOffset = content.indexOf(query);
  if (queryOffset < 0) return undefined;
  const symbolStart = locateContainingSymbolStart(content, queryOffset);
  if (symbolStart === undefined) return undefined;

  const header = topHeaderRegion(content);
  const headerBytes = header.length;
  const remaining = Math.max(0, budget - headerBytes);
  if (remaining <= 0) return undefined;

  const body = content.slice(symbolStart, symbolStart + remaining);
  const kept = header + body;
  if (kept.length === 0) return undefined;

  return {
    content: kept,
    truncated: true,
    truncatedHint: {
      strategy: 'ts-symbol-window',
      originalBytes: content.length,
      keptBytes: kept.length,
      droppedRanges: [
        ...(headerBytes < symbolStart ? [[headerBytes, symbolStart - 1] as [number, number]] : []),
        ...(symbolStart + body.length < content.length
          ? [[symbolStart + body.length, content.length - 1] as [number, number]]
          : [])
      ]
    }
  };
}

/**
 * Trims a workspace file's text to fit a byte budget for inclusion in a
 * ContextPack's selectedEvidenceContents. T08 ships the baseline slice
 * strategy; T09 adds ts-symbol-window for TS/JS/Vue.
 */
export function truncateContentForEvidence(
  path: string,
  content: string,
  budget: number,
  options?: { query?: string }
): EvidenceTruncationResult {
  const originalBytes = content.length;
  if (originalBytes === 0) {
    return { content: '', truncated: false };
  }
  const effectiveBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  if (effectiveBudget >= originalBytes) {
    return { content, truncated: false };
  }

  const ext = extensionOf(path);
  const query = options?.query?.trim();

  if (query && tsLikeExtensions.has(ext)) {
    const window = tsSymbolWindow(content, effectiveBudget, query);
    if (window) {
      // Defensive: if a degenerate symbol window exceeded budget, fall back.
      if (window.content.length <= effectiveBudget) return window;
    }
  }

  if (mdLikeExtensions.has(ext)) {
    const window = mdSectionWindow(content, effectiveBudget, query);
    if (window && window.content.length <= effectiveBudget) return window;
  }

  return sliceResult(content, effectiveBudget);
}

type MarkdownSection = {
  title: string;
  body: string; // includes the heading line + body, ends with '\n'
  startOffset: number;
};

function splitMarkdownSections(content: string): { topRegion: string; sections: MarkdownSection[] } {
  const lines = content.split('\n');
  const h2Indices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) h2Indices.push(i);
  }
  if (h2Indices.length === 0) {
    return { topRegion: content, sections: [] };
  }
  const topRegion = lines.slice(0, h2Indices[0]).join('\n');
  const topRegionWithTrailing = topRegion.length ? topRegion + '\n' : '';
  const sections: MarkdownSection[] = [];
  let cursor = topRegionWithTrailing.length;
  for (let i = 0; i < h2Indices.length; i += 1) {
    const start = h2Indices[i];
    const end = i + 1 < h2Indices.length ? h2Indices[i + 1] : lines.length;
    const sliceLines = lines.slice(start, end);
    const title = sliceLines[0].replace(/^##\s+/, '').trim();
    const body = sliceLines.join('\n') + '\n';
    sections.push({ title, body, startOffset: cursor });
    cursor += body.length;
  }
  return { topRegion: topRegionWithTrailing, sections };
}

function mdSectionWindow(
  content: string,
  budget: number,
  query: string | undefined
): EvidenceTruncationResult | undefined {
  const { topRegion, sections } = splitMarkdownSections(content);
  if (sections.length === 0) return undefined;

  // Top region (title + intro) is always preserved if it fits at all; if it
  // alone overflows budget, fall back to slice.
  if (topRegion.length > budget) return undefined;

  // Order sections by priority: query matches first (in original order), then
  // remaining sections in original order.
  const matchesQuery = (section: MarkdownSection): boolean => {
    if (!query) return false;
    return section.body.toLowerCase().includes(query.toLowerCase());
  };
  const queryMatches = sections.filter(matchesQuery);
  const rest = sections.filter((section) => !matchesQuery(section));
  const ordered = [...queryMatches, ...rest];

  const kept: MarkdownSection[] = [];
  const dropped: MarkdownSection[] = [];
  let used = topRegion.length;
  for (const section of ordered) {
    if (used + section.body.length <= budget) {
      kept.push(section);
      used += section.body.length;
    } else {
      dropped.push(section);
    }
  }

  if (kept.length === 0) {
    return undefined; // top region alone is not interesting; let slice handle it
  }

  // Reassemble in original document order so the output reads sensibly.
  const keptInOrder = sections.filter((section) => kept.includes(section));
  const droppedInOrder = sections.filter((section) => dropped.includes(section));
  const body = keptInOrder.map((section) => section.body).join('');
  const composed = topRegion + body;

  // Compute dropped byte ranges (each gap = a contiguous dropped section).
  const droppedRanges: Array<[number, number]> = [];
  for (const section of droppedInOrder) {
    const end = section.startOffset + section.body.length - 1;
    droppedRanges.push([section.startOffset, end]);
  }

  return {
    content: composed,
    truncated: true,
    truncatedHint: {
      strategy: 'md-section-window',
      originalBytes: content.length,
      keptBytes: composed.length,
      droppedRanges: droppedRanges.length ? droppedRanges : undefined,
      keptSections: keptInOrder.map((section) => section.title),
      droppedSections: droppedInOrder.map((section) => section.title)
    }
  };
}

