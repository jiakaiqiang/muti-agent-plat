export interface DiffRow {
  kind: 'equal' | 'add' | 'remove';
  text: string;
}

export interface ReportDiffPreview {
  path: string;
  mode: 'create' | 'update';
  rows: DiffRow[];
  addedLines: number;
  removedLines: number;
  requiresConfirmation: boolean;
}

export interface BuildReportDiffPreviewInput {
  path: string;
  nextContent: string;
  previousContent?: string;
}

export function buildReportDiffPreview(input: BuildReportDiffPreviewInput): ReportDiffPreview {
  const nextLines = input.nextContent.split('\n');
  if (!input.previousContent) {
    const rows = nextLines.map<DiffRow>((text) => ({ kind: 'add', text }));
    return {
      path: input.path,
      mode: 'create',
      rows,
      addedLines: nextLines.length,
      removedLines: 0,
      requiresConfirmation: true
    };
  }
  const previousLines = input.previousContent.split('\n');
  const rows = lcsDiff(previousLines, nextLines);
  const addedLines = rows.filter((row) => row.kind === 'add').length;
  const removedLines = rows.filter((row) => row.kind === 'remove').length;
  return {
    path: input.path,
    mode: 'update',
    rows,
    addedLines,
    removedLines,
    requiresConfirmation: addedLines + removedLines > 0
  };
}

function lcsDiff(previous: string[], next: string[]): DiffRow[] {
  const n = previous.length;
  const m = next.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (previous[i] === next[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (previous[i] === next[j]) {
      rows.push({ kind: 'equal', text: previous[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'remove', text: previous[i] });
      i += 1;
    } else {
      rows.push({ kind: 'add', text: next[j] });
      j += 1;
    }
  }
  while (i < n) rows.push({ kind: 'remove', text: previous[i++] });
  while (j < m) rows.push({ kind: 'add', text: next[j++] });
  return rows;
}
