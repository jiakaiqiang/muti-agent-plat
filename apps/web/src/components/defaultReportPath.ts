export interface DefaultReportPathInput {
  reportKind: string;
  title?: string;
  override?: string;
}

const KIND_TO_DEFAULT_FILENAME: Record<string, string> = {
  project_analysis_report: 'project-architecture-analysis.md',
  design_report: 'design-review.md',
  code_review_report: 'code-review.md'
};

const OUTPUT_DIRECTORY = 'agent-output';

export function defaultReportPath(input: DefaultReportPathInput): string {
  if (input.override && input.override.trim().length > 0) {
    return normalize(input.override.trim());
  }
  const filename = KIND_TO_DEFAULT_FILENAME[input.reportKind]
    ?? slugifyTitle(input.title)
    ?? 'report.md';
  return `${OUTPUT_DIRECTORY}/${filename}`;
}

function slugifyTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const trimmed = title.trim().toLowerCase();
  if (!trimmed) return undefined;
  const slug = trimmed
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return undefined;
  return `${slug}.md`;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
