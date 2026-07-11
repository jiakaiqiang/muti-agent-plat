import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SearchTextInput,
  SearchTextMatch,
  SearchTextResult,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import { isSensitivePath } from '../../common/path-safety.js';
import { resolveWorkspacePath } from './workspace-path.js';

const DEFAULT_MAX_RESULTS = 100;
const MAX_PREVIEW_LENGTH = 240;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 4000;

export interface SearchServerLocalTextArgs {
  rootPath: string;
  revision: WorkspaceRevision;
  input: SearchTextInput;
}

export async function searchServerLocalText(args: SearchServerLocalTextArgs): Promise<SearchTextResult> {
  const { rootPath, revision, input } = args;
  const { absolute: searchRootAbsolute, relative: searchRootRelative } = resolveWorkspacePath(
    rootPath,
    input.path ?? ''
  );
  const maxResults = Math.max(1, input.maxResults ?? DEFAULT_MAX_RESULTS);
  const caseSensitive = input.caseSensitive === true;
  const needle = caseSensitive ? input.query : input.query.toLowerCase();
  if (needle.length === 0) {
    return { matches: [], truncated: false, revision };
  }

  const matches: SearchTextMatch[] = [];
  let truncated = false;

  const stack: Array<{ absolute: string; relative: string }> = [
    { absolute: searchRootAbsolute, relative: searchRootRelative }
  ];

  while (stack.length > 0 && !truncated) {
    const current = stack.pop();
    if (!current) break;
    const dirents = await readdir(current.absolute, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const childRelative = current.relative ? `${current.relative}/${dirent.name}` : dirent.name;
      const childAbsolute = join(current.absolute, dirent.name);
      if (dirent.isDirectory()) {
        if (isGeneratedWorkspaceDirectory(dirent.name)) continue;
        if (isSensitivePath(childRelative)) continue;
        stack.push({ absolute: childAbsolute, relative: childRelative });
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isSensitivePath(childRelative)) continue;
      const stats = await stat(childAbsolute);
      if (stats.size > MAX_FILE_BYTES) continue;

      const buffer = await readFile(childAbsolute);
      if (looksBinary(buffer)) continue;
      const content = buffer.toString('utf8');
      const found = findLineMatches(content, needle, caseSensitive, childRelative);
      for (const match of found) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        matches.push(match);
      }
      if (truncated) break;
    }
  }

  return { matches, truncated, revision };
}

function looksBinary(buffer: Buffer): boolean {
  const scan = Math.min(buffer.byteLength, BINARY_PROBE_BYTES);
  for (let i = 0; i < scan; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function findLineMatches(
  content: string,
  needle: string,
  caseSensitive: boolean,
  path: string
): SearchTextMatch[] {
  const matches: SearchTextMatch[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column === -1) continue;
    matches.push({
      path,
      line: i + 1,
      column: column + 1,
      preview: buildPreview(line, column, needle.length)
    });
  }
  return matches;
}

function buildPreview(line: string, matchStart: number, matchLength: number): string {
  if (line.length <= MAX_PREVIEW_LENGTH) return line;
  const contextRadius = Math.floor((MAX_PREVIEW_LENGTH - matchLength) / 2);
  const start = Math.max(0, matchStart - contextRadius);
  const end = Math.min(line.length, start + MAX_PREVIEW_LENGTH);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return `${prefix}${line.slice(start, end)}${suffix}`.slice(0, MAX_PREVIEW_LENGTH);
}
