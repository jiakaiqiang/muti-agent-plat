import { normalizeGitHubRepositoryUrl } from '../github-repository-url.js';
import type { DeliveryDiff, DeliveryDiffFile } from '../contracts.js';

export type GitHubPullRequest = {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  baseBranch: string;
  mergeable: boolean | null;
  mergeCommitSha?: string;
};

export type GitHubCiStatus = 'not_configured' | 'pending' | 'failed' | 'passed';

const sha = /^[a-f0-9]{40}$/i;

export class GitHubPullRequests {
  constructor(private readonly request: typeof fetch = fetch) {}

  async find(token: string, repositoryUrl: string, branch: string,
    baseBranch: string): Promise<GitHubPullRequest | undefined> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    const owner = repo.repositoryId.split('/')[0];
    const query = new URLSearchParams({ state: 'all', head: `${owner}:${branch}`,
      base: baseBranch, per_page: '100' });
    const result = await this.json(token, `/repos/${repo.repositoryId}/pulls?${query}`);
    if (!Array.isArray(result)) throw new Error('GITHUB_PULL_LIST_INVALID');
    const matches = result.map((item) => this.parsePull(item, repo.repositoryId))
      .filter((item) => item.baseBranch === baseBranch);
    return matches.sort((a, b) => b.number - a.number)[0];
  }

  async get(token: string, repositoryUrl: string, number: number): Promise<GitHubPullRequest> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    this.assertNumber(number);
    return this.parsePull(await this.json(token, `/repos/${repo.repositoryId}/pulls/${number}`),
      repo.repositoryId);
  }

  async createOrReopen(token: string, repositoryUrl: string, branch: string,
    baseBranch: string, title: string): Promise<GitHubPullRequest> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    const existing = await this.find(token, repositoryUrl, branch, baseBranch);
    if (existing?.merged) throw new Error('GITHUB_PULL_ALREADY_MERGED');
    if (existing?.state === 'open') return this.get(token, repositoryUrl, existing.number);
    if (existing) {
      const reopened = await this.json(token, `/repos/${repo.repositoryId}/pulls/${existing.number}`,
        'PATCH', { state: 'open' });
      return this.parsePull(reopened, repo.repositoryId);
    }
    if (!title || title.length > 200) throw new Error('GITHUB_PULL_TITLE_INVALID');
    const created = await this.json(token, `/repos/${repo.repositoryId}/pulls`, 'POST',
      { title, head: branch, base: baseBranch,
        body: 'Created with Agent Cluster assistance. Review the diff and validation before merging.' });
    return this.parsePull(created, repo.repositoryId);
  }

  async ciStatus(token: string, repositoryUrl: string, headSha: string): Promise<GitHubCiStatus> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    if (!sha.test(headSha)) throw new Error('GITHUB_PULL_HEAD_INVALID');
    const [checks, statuses] = await Promise.all([
      this.json(token, `/repos/${repo.repositoryId}/commits/${headSha}/check-runs?per_page=100`),
      this.json(token, `/repos/${repo.repositoryId}/commits/${headSha}/status`)
    ]);
    if (!isRecord(checks) || !Array.isArray(checks.check_runs) ||
        !isRecord(statuses) || !Array.isArray(statuses.statuses) ||
        !['success', 'pending', 'failure'].includes(String(statuses.state))) {
      throw new Error('GITHUB_CI_RESPONSE_INVALID');
    }
    const runs = checks.check_runs;
    const contexts = statuses.statuses;
    if (!runs.length && !contexts.length) return 'not_configured';
    if (runs.some((run) => isRecord(run) && run.status === 'completed' &&
        !['success', 'neutral', 'skipped'].includes(String(run.conclusion))) ||
        statuses.state === 'failure') return 'failed';
    if (typeof checks.total_count === 'number' && checks.total_count > runs.length) return 'pending';
    if (runs.some((run) => !isRecord(run) || run.status !== 'completed') ||
        contexts.length > 0 && statuses.state === 'pending') return 'pending';
    return 'passed';
  }

  async squashMerge(token: string, repositoryUrl: string, number: number,
    expectedHeadSha: string): Promise<string> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    this.assertNumber(number);
    if (!sha.test(expectedHeadSha)) throw new Error('GITHUB_PULL_HEAD_INVALID');
    const merged = await this.json(token, `/repos/${repo.repositoryId}/pulls/${number}/merge`,
      'PUT', { merge_method: 'squash', sha: expectedHeadSha });
    if (!isRecord(merged) || merged.merged !== true ||
        typeof merged.sha !== 'string' || !sha.test(merged.sha)) {
      throw new Error('GITHUB_MERGE_RESPONSE_INVALID');
    }
    return merged.sha;
  }

  async diff(token: string, repositoryUrl: string, input: {
    kind: 'pull_request' | 'merged_commit'; number?: number; sha: string; page: number
  }): Promise<DeliveryDiff> {
    const repo = normalizeGitHubRepositoryUrl(repositoryUrl);
    if (!sha.test(input.sha) || !Number.isSafeInteger(input.page) ||
        input.page < 1 || input.page > 30) throw new Error('GITHUB_DIFF_REQUEST_INVALID');
    if (input.kind === 'pull_request' && !input.number) {
      throw new Error('GITHUB_DIFF_REQUEST_INVALID');
    }
    let values: unknown;
    if (input.kind === 'pull_request') {
      this.assertNumber(input.number!);
      const pull = await this.get(token, repositoryUrl, input.number!);
      if (pull.headSha !== input.sha) throw new Error('GITHUB_PULL_HEAD_CHANGED');
      values = await this.json(token,
        `/repos/${repo.repositoryId}/pulls/${input.number}/files?per_page=100&page=${input.page}`);
      const after = await this.get(token, repositoryUrl, input.number!);
      if (after.headSha !== input.sha) throw new Error('GITHUB_PULL_HEAD_CHANGED');
    } else {
      const commit = await this.json(token,
        `/repos/${repo.repositoryId}/commits/${input.sha}?per_page=100&page=${input.page}`);
      if (!isRecord(commit) || !Array.isArray(commit.files) ||
          !isRecord(commit.commit) || !isRecord(commit.commit.tree)) {
        throw new Error('GITHUB_COMMIT_DIFF_INVALID');
      }
      values = commit.files;
    }
    if (!Array.isArray(values)) throw new Error('GITHUB_DIFF_RESPONSE_INVALID');
    if (input.page === 30 && values.length === 100) {
      throw new Error('GITHUB_DIFF_FILE_LIMIT_EXCEEDED');
    }
    const files = values.map((value): DeliveryDiffFile => {
      if (!isRecord(value) || typeof value.filename !== 'string' ||
          typeof value.status !== 'string' ||
          !Number.isSafeInteger(value.additions) || !Number.isSafeInteger(value.deletions)) {
        throw new Error('GITHUB_DIFF_RESPONSE_INVALID');
      }
      return { path: value.filename, status: value.status,
        additions: value.additions as number, deletions: value.deletions as number,
        ...(typeof value.patch === 'string'
          ? { patch: value.patch.slice(0, 100_000) } : {}),
        ...(typeof value.previous_filename === 'string'
          ? { previousPath: value.previous_filename } : {}) };
    });
    return { kind: input.kind, sha: input.sha, files,
      page: input.page, hasMore: values.length === 100 };
  }

  private assertNumber(number: number): void {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('GITHUB_PULL_NUMBER_INVALID');
  }

  private parsePull(value: unknown, repositoryId: string): GitHubPullRequest {
    if (!isRecord(value) || !Number.isSafeInteger(value.number) ||
        !['open', 'closed'].includes(String(value.state)) ||
        !isRecord(value.head) || typeof value.head.sha !== 'string' || !sha.test(value.head.sha) ||
        !isRecord(value.base) || typeof value.base.ref !== 'string' ||
        typeof value.html_url !== 'string') throw new Error('GITHUB_PULL_RESPONSE_INVALID');
    const url = new URL(value.html_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
        !url.pathname.startsWith(`/${repositoryId}/pull/`) || url.username || url.password) {
      throw new Error('GITHUB_PULL_URL_INVALID');
    }
    return { number: value.number as number, url: url.href,
      state: value.state as 'open' | 'closed', merged: Boolean(value.merged_at),
      headSha: value.head.sha, baseBranch: value.base.ref,
      mergeable: typeof value.mergeable === 'boolean' ? value.mergeable : null,
      ...(typeof value.merge_commit_sha === 'string' && sha.test(value.merge_commit_sha)
        ? { mergeCommitSha: value.merge_commit_sha } : {}) };
  }

  private async json(token: string, path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'User-Agent': 'agent-cluster', 'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new Error('GITHUB_API_UNAVAILABLE'); }
    if (!response.ok) throw new Error(`GITHUB_API_HTTP_${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('GITHUB_API_RESPONSE_INVALID'); }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
