import type { WorkspaceIndexEntry, WorkspaceSnapshot } from '@agent-cluster/shared';

const README_PATTERN = /^readme(\.[a-z0-9]+)?$/i;
const CONVENTIONAL_ENTRY_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.mjs',
  'index.cjs',
  'main.ts',
  'main.tsx',
  'main.js',
  'main.mjs',
  'main.cjs',
  'server.ts',
  'server.js'
]);

export function deriveWorkspaceEntrypoints(
  snapshot: WorkspaceSnapshot,
  index: WorkspaceIndexEntry[]
): string[] {
  const eligible = new Map<string, WorkspaceIndexEntry>();
  for (const entry of index) {
    if (entry.kind !== 'file') continue;
    if (entry.generated) continue;
    if (entry.sensitive) continue;
    eligible.set(entry.path, entry);
  }

  const results = new Set<string>();
  for (const [path] of eligible) {
    const basename = path.split('/').pop() ?? '';
    if (README_PATTERN.test(basename)) results.add(path);
    if (basename === 'package.json') results.add(path);
    if (CONVENTIONAL_ENTRY_BASENAMES.has(basename)) results.add(path);
  }

  for (const path of collectPackageJsonReferences(snapshot)) {
    if (eligible.has(path)) results.add(path);
  }

  return Array.from(results).sort();
}

function collectPackageJsonReferences(snapshot: WorkspaceSnapshot): string[] {
  const refs = new Set<string>();
  for (const file of snapshot.files) {
    if (file.path.split('/').pop() !== 'package.json') continue;
    if (!file.content) continue;
    const parsed = tryParseJson(file.content);
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    for (const field of ['main', 'module', 'browser'] as const) {
      const value = record[field];
      if (typeof value === 'string') refs.add(normalizeRef(file.path, value));
    }
    const bin = record.bin;
    if (typeof bin === 'string') refs.add(normalizeRef(file.path, bin));
    if (bin && typeof bin === 'object') {
      for (const value of Object.values(bin as Record<string, unknown>)) {
        if (typeof value === 'string') refs.add(normalizeRef(file.path, value));
      }
    }
  }
  return Array.from(refs);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeRef(packageJsonPath: string, ref: string): string {
  const dir = packageJsonPath.split('/').slice(0, -1).join('/');
  const trimmed = ref.replace(/^\.\/+/, '');
  return dir ? `${dir}/${trimmed}` : trimmed;
}
