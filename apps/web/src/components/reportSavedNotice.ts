export interface ReportSavedNoticeInput {
  path: string;
  revisionId?: string;
  appliedCount: number;
  savedAt?: string;
}

export interface ReportSavedNotice {
  kind: 'report_saved';
  message: string;
  path: string;
  revisionId?: string;
  appliedCount: number;
  savedAt?: string;
}

export function buildReportSavedNotice(input: ReportSavedNoticeInput): ReportSavedNotice {
  const message = `报告已保存到 ${input.path}`;
  return {
    kind: 'report_saved',
    message,
    path: input.path,
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    appliedCount: input.appliedCount,
    ...(input.savedAt ? { savedAt: input.savedAt } : {})
  };
}
