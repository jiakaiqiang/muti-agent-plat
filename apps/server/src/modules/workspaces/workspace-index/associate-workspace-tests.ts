import type { WorkspaceIndexEntry } from '@agent-cluster/shared';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const TEST_SUFFIXES = ['.spec', '.test'] as const;

interface SplitPath {
  dir: string;
  basename: string;
  extension: string;
}

export function associateWorkspaceTests(
  entries: WorkspaceIndexEntry[]
): Map<string, string[]> {
  const filesByPath = new Map<string, WorkspaceIndexEntry>();
  for (const entry of entries) {
    if (entry.kind === 'file') filesByPath.set(entry.path, entry);
  }

  const testCandidatesBySourcePath = new Map<string, Set<string>>();

  for (const [path] of filesByPath) {
    const split = splitPath(path);
    if (!isSourceExtension(split.extension)) continue;
    const testSuffix = matchedTestSuffix(split.basename);
    if (!testSuffix) continue;

    const sourceBasename = split.basename.slice(0, -testSuffix.length);
    for (const sourcePath of candidateSourcePaths(split.dir, sourceBasename, split.extension)) {
      if (!filesByPath.has(sourcePath)) continue;
      const set = testCandidatesBySourcePath.get(sourcePath) ?? new Set<string>();
      set.add(path);
      testCandidatesBySourcePath.set(sourcePath, set);
    }
  }

  const result = new Map<string, string[]>();
  for (const [source, tests] of testCandidatesBySourcePath) {
    result.set(source, Array.from(tests).sort());
  }
  return result;
}

function splitPath(path: string): SplitPath {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash);
  const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return { dir, basename: filename, extension: '' };
  return { dir, basename: filename.slice(0, lastDot), extension: filename.slice(lastDot) };
}

function isSourceExtension(extension: string): boolean {
  return (SOURCE_EXTENSIONS as readonly string[]).includes(extension);
}

function matchedTestSuffix(basename: string): string | null {
  for (const suffix of TEST_SUFFIXES) {
    if (basename.endsWith(suffix)) return suffix;
  }
  return null;
}

function candidateSourcePaths(dir: string, sourceBasename: string, extension: string): string[] {
  const candidates: string[] = [];
  const filename = `${sourceBasename}${extension}`;
  if (dir) {
    candidates.push(`${dir}/${filename}`);
    if (dir.endsWith('/__tests__')) {
      const parent = dir.slice(0, -'/__tests__'.length);
      candidates.push(parent ? `${parent}/${filename}` : filename);
    }
  } else {
    candidates.push(filename);
  }
  return candidates;
}
