import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isGeneratedWorkspaceDirectory, isSensitiveWorkspacePath, isWorkspaceTextContent, type IntentSourceAuthorizationCandidate } from '@agent-cluster/shared';
import { inspectSourceFile, inspectSourceRoot } from './intent-source-authority.js';
import { INTENT_SOURCE_WRITE_LIMITS } from '../workspaces/intent-source-write-guard.js';

export const SOURCE_AUTH_CANDIDATE_PAGE_SIZE = 50;
export const SOURCE_AUTH_CANDIDATE_TOTAL_LIMIT = 500;
export const SOURCE_AUTH_CANDIDATE_TTL_MS = 10 * 60_000;
export const SOURCE_AUTH_CANDIDATE_SCAN_MAX_ENTRIES = 20_000;
export const SOURCE_AUTH_CANDIDATE_SCAN_MAX_MS = 2_000;

type GitIgnoreRule = { regex: RegExp; negated: boolean };

function globRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        source += '(?:.*/)?';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(`^${source}(?:/.*)?$`, 'i');
}

function parseGitIgnore(content: string): GitIgnoreRule[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const negated = trimmed.startsWith('!');
    let pattern = (negated ? trimmed.slice(1) : trimmed).trim();
    if (!pattern) return [];
    if (pattern.endsWith('/')) pattern = `${pattern}**`;
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    if (!pattern.includes('/')) pattern = `**/${pattern}`;
    return [{ regex: globRegex(pattern), negated }];
  });
}

async function loadGitIgnore(rootPath: string): Promise<GitIgnoreRule[]> {
  try { return parseGitIgnore(await readFile(join(rootPath, '.gitignore'), 'utf8')); }
  catch { return []; }
}

function ignoredByGitIgnore(path: string, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) if (rule.regex.test(path)) ignored = !rule.negated;
  return ignored;
}

function candidateHash(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function scanSourceAuthorizationCandidates(input: {
  rootPath: string;
  query?: string;
  suggestedPaths: ReadonlySet<string>;
  prior?: readonly IntentSourceAuthorizationCandidate[];
  scanBudget?: { maxEntries?: number; maxMs?: number };
}) {
  const rootIdentity = await inspectSourceRoot(input.rootPath);
  const rules = await loadGitIgnore(input.rootPath);
  const prior = new Map((input.prior ?? []).map((candidate) => [candidate.path, candidate]));
  const found: IntentSourceAuthorizationCandidate[] = [];
  const pending = [input.rootPath];
  const query = input.query?.trim().toLocaleLowerCase('en-US') ?? '';
  const maxEntries = Math.max(1, Math.min(input.scanBudget?.maxEntries ?? SOURCE_AUTH_CANDIDATE_SCAN_MAX_ENTRIES, SOURCE_AUTH_CANDIDATE_SCAN_MAX_ENTRIES));
  const maxMs = Math.max(1, Math.min(input.scanBudget?.maxMs ?? SOURCE_AUTH_CANDIDATE_SCAN_MAX_MS, SOURCE_AUTH_CANDIDATE_SCAN_MAX_MS));
  const startedAt = Date.now();
  let scannedEntries = 0;
  let truncatedReason: string | undefined;
  while (pending.length) {
    if (scannedEntries >= maxEntries) { truncatedReason = 'entry_scan_budget_exhausted'; break; }
    if (Date.now() - startedAt >= maxMs) { truncatedReason = 'time_scan_budget_exhausted'; break; }
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries++;
      if (scannedEntries > maxEntries) { truncatedReason = 'entry_scan_budget_exhausted'; break; }
      if (Date.now() - startedAt >= maxMs) { truncatedReason = 'time_scan_budget_exhausted'; break; }
      const absolutePath = join(directory, entry.name);
      const path = relative(input.rootPath, absolutePath).replace(/\\/g, '/');
      if (!path || isSensitiveWorkspacePath(path) || ignoredByGitIgnore(path, rules)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isGeneratedWorkspaceDirectory(entry.name)) continue;
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      // Search by path before opening a file. Metadata checks keep the scan bounded;
      // full content and hashing happen only after the path matches the query.
      if (query && !path.toLocaleLowerCase('en-US').includes(query)) {
        try {
          const metadata = await lstat(absolutePath);
          if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > INTENT_SOURCE_WRITE_LIMITS.fileBytes) continue;
        } catch { continue; }
        continue;
      }
      try {
        const inspected = await inspectSourceFile(input.rootPath, path);
        if (!isWorkspaceTextContent(inspected.content)) continue;
        const previous = prior.get(path);
        const expiresAt = previous && Date.parse(previous.expiresAt) > Date.now() &&
          previous.dev === inspected.dev && previous.ino === inspected.ino && previous.hash === inspected.hash.value &&
          previous.rootIdentity.dev === rootIdentity.dev && previous.rootIdentity.ino === rootIdentity.ino
          ? previous.expiresAt : new Date(Date.now() + SOURCE_AUTH_CANDIDATE_TTL_MS).toISOString();
        found.push({ ref: previous?.ref && expiresAt === previous.expiresAt ? previous.ref : `intent-source-candidate-ref:${randomUUID()}`,
          path, size: Buffer.byteLength(inspected.content, 'utf8'), hash: candidateHash(inspected.content), dev: inspected.dev, ino: inspected.ino,
          rootIdentity, expiresAt, suggested: input.suggestedPaths.has(path) });
      } catch {
        // Listing is fail-closed: any race, binary body, link or oversized file is omitted.
      }
      if (found.length > SOURCE_AUTH_CANDIDATE_TOTAL_LIMIT) {
        found.pop();
        truncatedReason = 'matching_result_limit_reached';
        break;
      }
    }
    if (truncatedReason) break;
  }
  found.sort((left, right) => left.path.localeCompare(right.path));
  return { rootIdentity, catalog: found, filtered: found, total: found.length, truncated: Boolean(truncatedReason), truncatedReason };
}
