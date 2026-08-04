export type ThreeWayMergeResult =
  | { ok: true; content: string; merged: boolean }
  | { ok: false; reason: 'overlapping_changes' | 'input_too_large' };

type Hunk = {
  start: number;
  end: number;
  replacement: string[];
};

const MAX_LCS_CELLS = 4_000_000;

/**
 * Conservative line-based three-way merge. It applies non-overlapping edits
 * from `current` and `candidate` and reports overlap without writing markers.
 */
export function mergeWorkspaceText(base: string, current: string, candidate: string): ThreeWayMergeResult {
  if (current === candidate) return { ok: true, content: current, merged: false };
  if (current === base) return { ok: true, content: candidate, merged: false };
  if (candidate === base) return { ok: true, content: current, merged: false };

  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  const candidateLines = splitLines(candidate);
  if (
    (baseLines.length + 1) * (currentLines.length + 1) > MAX_LCS_CELLS ||
    (baseLines.length + 1) * (candidateLines.length + 1) > MAX_LCS_CELLS
  ) {
    return { ok: false, reason: 'input_too_large' };
  }

  const currentHunks = diffHunks(baseLines, currentLines);
  const candidateHunks = diffHunks(baseLines, candidateLines);
  const mergedHunks: Hunk[] = [...currentHunks];
  for (const candidateHunk of candidateHunks) {
    const matches = mergedHunks.find((currentHunk) => sameHunk(currentHunk, candidateHunk));
    if (matches) continue;
    if (mergedHunks.some((currentHunk) => overlaps(currentHunk, candidateHunk))) {
      return { ok: false, reason: 'overlapping_changes' };
    }
    mergedHunks.push(candidateHunk);
  }

  const result = [...baseLines];
  for (const hunk of mergedHunks.sort((left, right) => right.start - left.start || right.end - left.end)) {
    result.splice(hunk.start, hunk.end - hunk.start, ...hunk.replacement);
  }
  return { ok: true, content: result.join(''), merged: true };
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffHunks(base: string[], target: string[]): Hunk[] {
  const width = target.length + 1;
  const table = new Uint32Array((base.length + 1) * width);
  for (let left = base.length - 1; left >= 0; left -= 1) {
    for (let right = target.length - 1; right >= 0; right -= 1) {
      const offset = left * width + right;
      table[offset] = base[left] === target[right]
        ? table[(left + 1) * width + right + 1] + 1
        : Math.max(table[(left + 1) * width + right], table[left * width + right + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let left = 0;
  let right = 0;
  let active: Hunk | undefined;
  const flush = () => {
    if (active) hunks.push(active);
    active = undefined;
  };
  while (left < base.length || right < target.length) {
    if (left < base.length && right < target.length && base[left] === target[right]) {
      flush();
      left += 1;
      right += 1;
      continue;
    }
    active ??= { start: left, end: left, replacement: [] };
    const insert = right < target.length && (
      left === base.length || table[left * width + right + 1] >= table[(left + 1) * width + right]
    );
    if (insert) {
      active.replacement.push(target[right]);
      right += 1;
    } else {
      left += 1;
      active.end = left;
    }
  }
  flush();
  return hunks;
}

function sameHunk(left: Hunk, right: Hunk) {
  return left.start === right.start && left.end === right.end &&
    left.replacement.length === right.replacement.length &&
    left.replacement.every((line, index) => line === right.replacement[index]);
}

function overlaps(left: Hunk, right: Hunk) {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start < right.end;
  if (rightInsertion) return right.start >= left.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}
