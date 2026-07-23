const SAVEABLE_KINDS = new Set(['project_analysis_report', 'design_report', 'code_review_report']);

export interface SaveableReport {
  kind: string;
  format: string;
  content: string;
  userConfirmed: boolean;
}

export function canShowSaveMarkdownButton(report: SaveableReport): boolean {
  if (!report.userConfirmed) return false;
  if (report.format !== 'markdown') return false;
  if (!SAVEABLE_KINDS.has(report.kind)) return false;
  return report.content.trim().length > 0;
}
