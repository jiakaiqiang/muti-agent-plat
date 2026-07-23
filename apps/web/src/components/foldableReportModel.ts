export interface FoldableReportInput {
  content: string;
  threshold?: number;
  expanded?: boolean;
}

export interface FoldableReportModel {
  fullContent: string;
  preview: string;
  canExpand: boolean;
  isFolded: boolean;
  totalLines: number;
  previewLines: number;
}

const DEFAULT_THRESHOLD_LINES = 20;

export function foldableReportModel(input: FoldableReportInput): FoldableReportModel {
  const fullContent = input.content ?? '';
  const threshold = Math.max(1, input.threshold ?? DEFAULT_THRESHOLD_LINES);
  const lines = fullContent.split('\n');
  const totalLines = lines.length;
  const canExpand = totalLines > threshold;
  if (!canExpand) {
    return {
      fullContent,
      preview: fullContent,
      canExpand: false,
      isFolded: false,
      totalLines,
      previewLines: totalLines
    };
  }
  const isFolded = !input.expanded;
  const preview = isFolded ? lines.slice(0, threshold).join('\n') : fullContent;
  return {
    fullContent,
    preview,
    canExpand: true,
    isFolded,
    totalLines,
    previewLines: isFolded ? threshold : totalLines
  };
}
