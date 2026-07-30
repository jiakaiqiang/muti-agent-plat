import type {
  FileRevisionDiffHunk,
  FileRevisionDiffLine,
  FileRevisionDiffSummary
} from '@agent-cluster/shared';

type DiffResult = {
  hunks: FileRevisionDiffHunk[];
  summary: FileRevisionDiffSummary;
};

export type FileRevisionDiffLimits = {
  maxInputBytes: number;
  maxLines: number;
  maxEditDistance: number;
  timeoutMs: number;
};

export const DEFAULT_FILE_REVISION_DIFF_LIMITS: FileRevisionDiffLimits = {
  maxInputBytes: 400_000,
  maxLines: 20_000,
  maxEditDistance: 4_000,
  timeoutMs: 1_000
};

const CONTEXT_LINES = 3;

/** Deterministic Myers line diff. It is data processing, never an LLM judgment. */
export function createFileRevisionDiff(
  original: string,
  revised: string,
  limits: FileRevisionDiffLimits = DEFAULT_FILE_REVISION_DIFF_LIMITS
): DiffResult {
  const inputBytes = Buffer.byteLength(original, 'utf8') + Buffer.byteLength(revised, 'utf8');
  if (inputBytes > limits.maxInputBytes) {
    throw new Error(`REVISION_DIFF_INPUT_TOO_LARGE: ${inputBytes} > ${limits.maxInputBytes}`);
  }
  const originalLines = splitLines(original);
  const revisedLines = splitLines(revised);
  if (originalLines.length > limits.maxLines || revisedLines.length > limits.maxLines) {
    throw new Error(`REVISION_DIFF_TOO_MANY_LINES: maximum is ${limits.maxLines}`);
  }
  const edits = myersDiff(originalLines, revisedLines, limits);
  const hunks = createHunks(edits);
  return {
    hunks,
    summary: {
      addedLines: edits.filter((line) => line.kind === 'add').length,
      removedLines: edits.filter((line) => line.kind === 'remove').length,
      unchangedLines: edits.filter((line) => line.kind === 'context').length,
      hunkCount: hunks.length
    }
  };
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.replace(/\r\n/g, '\n').split('\n');
}

function myersDiff(
  original: string[],
  revised: string[],
  limits: FileRevisionDiffLimits
): FileRevisionDiffLine[] {
  const maximum = original.length + revised.length;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>([[1, 0]]);
  const deadline = Date.now() + limits.timeoutMs;

  for (let distance = 0; distance <= Math.min(maximum, limits.maxEditDistance); distance += 1) {
    if (Date.now() > deadline) throw new Error('REVISION_DIFF_TIMEOUT');
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < original.length && y < revised.length && original[x] === revised[y]) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= original.length && y >= revised.length) {
        trace.push(next);
        return backtrack(trace, original, revised);
      }
    }
    trace.push(next);
    frontier = next;
  }
  throw new Error(`REVISION_DIFF_COMPLEXITY_EXCEEDED: edit distance exceeds ${limits.maxEditDistance}`);
}

function backtrack(trace: Array<Map<number, number>>, original: string[], revised: string[]) {
  const edits: FileRevisionDiffLine[] = [];
  let x = original.length;
  let y = revised.length;

  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1]!;
    const diagonal = x - y;
    const down = previous.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = previous.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      edits.push({ kind: 'context', content: original[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      edits.push({ kind: 'add', content: revised[y - 1]! });
      y -= 1;
    } else {
      edits.push({ kind: 'remove', content: original[x - 1]! });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    edits.push({ kind: 'context', content: original[x - 1]! });
    x -= 1;
    y -= 1;
  }
  while (x > 0) edits.push({ kind: 'remove', content: original[--x]! });
  while (y > 0) edits.push({ kind: 'add', content: revised[--y]! });
  return edits.reverse();
}

function createHunks(edits: FileRevisionDiffLine[]): FileRevisionDiffHunk[] {
  const changed = edits
    .map((line, index) => line.kind === 'context' ? -1 : index)
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(edits.length, index + CONTEXT_LINES + 1);
    const current = ranges.at(-1);
    if (current && start <= current.end) current.end = Math.max(current.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map(({ start, end }) => {
    let oldStart = 1;
    let newStart = 1;
    for (const line of edits.slice(0, start)) {
      if (line.kind !== 'add') oldStart += 1;
      if (line.kind !== 'remove') newStart += 1;
    }
    const lines = edits.slice(start, end);
    return {
      oldStart,
      oldLines: lines.filter((line) => line.kind !== 'add').length,
      newStart,
      newLines: lines.filter((line) => line.kind !== 'remove').length,
      lines
    };
  });
}
