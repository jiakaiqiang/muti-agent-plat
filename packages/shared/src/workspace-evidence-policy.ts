import type { WorkspaceIndexQueryInput, WorkspaceIndexQueryResult, WorkspaceIndexSnapshot } from './contracts.js';
import { isGeneratedWorkspaceDirectory } from './workspace-ignore.js';
import { isSensitiveWorkspacePath } from './workspace-path-safety.js';

const binarySuffix = /\.(?:pyd|pyc|pyo|dll|exe|so|dylib|class|jar|zip|gz|tar|7z|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|mp[34]|wav|sqlite3?|db|bin|dat)$/i;
const manifestName = /^(?:package\.json|readme\.md|agents\.md|claude\.md|pom\.xml|build\.gradle(?:\.kts)?|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/i;

export function isBinaryWorkspacePath(path: string): boolean {
  return binarySuffix.test(path);
}

/** Shared by both providers, automatic evidence selection, and the evidence gate. */
export function isUsableWorkspaceEvidencePath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/');
  return !parts.some(isGeneratedWorkspaceDirectory) && !isSensitiveWorkspacePath(path) && !binarySuffix.test(path);
}

export function isWorkspaceTextContent(content: string): boolean {
  // Source files can contain literal ANSI escapes (for example a terminal UI).
  // NUL or a high density of invalid/control characters indicates a binary body.
  return Boolean(content.trim()) && !content.includes('\0') &&
    (content.match(/[\x01-\x08\x0e-\x1f]/g)?.length ?? 0) <= Math.max(4, content.length * 0.02) &&
    (content.match(/\ufffd/g)?.length ?? 0) <= Math.max(1, content.length * 0.01);
}

export function workspaceEvidencePriority(path: string): number {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (!isUsableWorkspaceEvidencePath(normalized)) return -1;
  const name = normalized.split('/').at(-1)!;
  let score = manifestName.test(name) ? 120 : 10;
  if (/^(main|app|server|bootstrap|__main__)\.(ts|tsx|js|mjs|py|go|rs|java|kt)$/.test(name)) score = 110;
  else if (/^(index|cli)\.(ts|js|py)$/.test(name)) score = 90;
  else if (/(^|\/)(src|modules|services|routes|api|tools|models|contracts)\//.test(normalized)) score += 40;
  if (/(^|\/)(tests?|__tests__|e2e)\/|\.(spec|test)\./.test(normalized)) score -= 30;
  return score - normalized.split('/').length;
}

export function deriveWorkspaceIndexEntrypoints(entries: WorkspaceIndexSnapshot['entries']): string[] {
  return entries.filter(entry => entry.kind === 'file' && !entry.generated && !entry.sensitive &&
    isUsableWorkspaceEvidencePath(entry.path) && manifestName.test(entry.path.split('/').at(-1)!))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    .slice(0, 32).map(entry => entry.path);
}

/** Intent describes the task; it must never become a literal filename search term. */
export function queryWorkspaceNavigation(snapshot: WorkspaceIndexSnapshot, input: WorkspaceIndexQueryInput = {}): WorkspaceIndexQueryResult {
  if (input.generation !== undefined && input.generation !== snapshot.generation) return { ...snapshot, entries: [], matched: 0 };
  const terms = [...(input.pathHints ?? []), ...(input.symbols ?? []),
    ...(input.query?.match(/[\p{L}\p{N}_./-]+/gu) ?? []).flatMap(term =>
      /\p{Script=Han}/u.test(term)
        ? [term, ...Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(term), part => part.segment)]
        : [term])]
    .map(term => term.toLowerCase()).filter(term => term.length >= 2);
  const overview = /架构|结构|目录|项目|architecture|project|structure/i.test(input.query ?? '');
  const eligible = snapshot.entries.filter(entry => !entry.generated && !entry.sensitive && isUsableWorkspaceEvidencePath(entry.path));
  // Recompute from entries so persisted indexes made by older runtimes cannot omit nested projects.
  const entrypoints = deriveWorkspaceIndexEntrypoints(eligible);
  const roots = new Set(entrypoints);
  const ranked = eligible.map(entry => ({ entry,
    matches: terms.filter(term => entry.path.toLowerCase().includes(term)).length,
    priority: workspaceEvidencePriority(entry.path) + (entry.kind === 'file' ? 10 : 0)
  })).sort((a, b) => b.matches - a.matches || b.priority - a.priority || a.entry.path.localeCompare(b.entry.path));
  const matched = ranked.filter(item => item.matches > 0);
  const candidates = [...new Map([
    ...eligible.filter(entry => roots.has(entry.path)),
    ...(overview || !matched.length ? ranked : matched).map(item => item.entry)
  ].map(entry => [entry.path, entry])).values()];
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  return { ...snapshot, entrypoints, entries: candidates.slice(0, limit), matched: matched.length,
    truncated: snapshot.truncated || candidates.length > limit };
}
