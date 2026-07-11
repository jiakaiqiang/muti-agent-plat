import type { WorkspaceIndexEntry } from '@agent-cluster/shared';

export interface ScoreEvidenceCandidatesArgs {
  entries: WorkspaceIndexEntry[];
  entrypoints?: string[];
  userMentionedPaths?: string[];
  userKeywords?: string[];
}

export interface ScoredEvidenceCandidate {
  path: string;
  score: number;
  reasons: string[];
}

const CONTRACT_HINTS = ['contracts', 'contract', 'schema', 'types'];

export function scoreEvidenceCandidates(
  args: ScoreEvidenceCandidatesArgs
): ScoredEvidenceCandidate[] {
  const entrypointSet = new Set(args.entrypoints ?? []);
  const mentionedSet = new Set(args.userMentionedPaths ?? []);
  const keywords = (args.userKeywords ?? [])
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword) => keyword.length > 0);

  const candidates: ScoredEvidenceCandidate[] = [];

  for (const entry of args.entries) {
    if (entry.kind !== 'file') continue;
    if (entry.generated || entry.sensitive) continue;

    let score = 0;
    const reasons: string[] = [];

    if (mentionedSet.has(entry.path)) {
      score += 500;
      reasons.push('user-mentioned');
    }
    if (entrypointSet.has(entry.path)) {
      score += 200;
      reasons.push('entrypoint');
    }
    if (isContractLike(entry.path)) {
      score += 120;
      reasons.push('contract');
    }
    if (isTestPath(entry.path)) {
      score += 40;
      reasons.push('test');
    }
    const keywordHits = countKeywordHits(entry.path, keywords);
    if (keywordHits > 0) {
      score += keywordHits * 30;
      reasons.push(`keyword-match:${keywordHits}`);
    }
    const depth = entry.path.split('/').filter(Boolean).length;
    score += Math.max(0, 8 - depth);

    if (score === 0) continue;
    candidates.push({ path: entry.path, score, reasons });
  }

  candidates.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
  return candidates;
}

function isContractLike(path: string): boolean {
  const lower = path.toLowerCase();
  return CONTRACT_HINTS.some((hint) => lower.includes(`/${hint}/`) || lower.endsWith(`/${hint}.ts`)) ||
    lower.endsWith('/contracts.ts');
}

function isTestPath(path: string): boolean {
  const basename = path.split('/').pop() ?? '';
  const withoutExt = basename.replace(/\.[^.]+$/, '');
  return withoutExt.endsWith('.spec') || withoutExt.endsWith('.test') || path.includes('/__tests__/');
}

function countKeywordHits(path: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = path.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) hits += 1;
  }
  return hits;
}
