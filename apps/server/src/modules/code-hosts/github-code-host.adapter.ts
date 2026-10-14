import type { GitHubRepositoryRef } from './github-repository-url.js';

export type CodeHostIdentity = {
  id: string;
  login: string;
  name?: string;
  email?: string;
};

export type CodeHostRepository = {
  id: string;
  defaultBranch: string;
  canPush: true;
};

export type CodeHostBranch = { name: string; sha: string };

export interface CodeHostAdapter {
  readonly provider: 'github';
  identify(token: string): Promise<CodeHostIdentity>;
  inspectRepository(token: string, repository: GitHubRepositoryRef): Promise<CodeHostRepository>;
  listBranches(token: string, repository: GitHubRepositoryRef): Promise<CodeHostBranch[]>;
}

export class GitHubCodeHostAdapter implements CodeHostAdapter {
  readonly provider = 'github' as const;
  private request = fetch;

  async identify(token: string): Promise<CodeHostIdentity> {
    const user = await this.getJson(token, '/user');
    if (!isRecord(user) || !Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !user.login) {
      throw new Error('GITHUB_IDENTITY_INVALID');
    }
    return {
      id: String(user.id), login: user.login,
      ...(typeof user.name === 'string' && user.name ? { name: user.name } : {}),
      ...(typeof user.email === 'string' && user.email ? { email: user.email } : {})
    };
  }

  async inspectRepository(token: string, repository: GitHubRepositoryRef): Promise<CodeHostRepository> {
    const data = await this.getJson(token, `/repos/${repository.repositoryId}`);
    if (!isRecord(data) || !Number.isSafeInteger(data.id) ||
        typeof data.default_branch !== 'string' || !data.default_branch) {
      throw new Error('GITHUB_REPOSITORY_RESPONSE_INVALID');
    }
    const permissions = isRecord(data.permissions) ? data.permissions : {};
    if (permissions.push !== true) throw new Error('GITHUB_REPOSITORY_WRITE_REQUIRED');
    return { id: String(data.id), defaultBranch: data.default_branch, canPush: true };
  }

  async listBranches(token: string, repository: GitHubRepositoryRef): Promise<CodeHostBranch[]> {
    const branches: CodeHostBranch[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.getJson(token, `/repos/${repository.repositoryId}/branches?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error('GITHUB_BRANCH_LIST_INVALID');
      for (const entry of data) {
        if (!isRecord(entry) || typeof entry.name !== 'string' ||
            !isRecord(entry.commit) || typeof entry.commit.sha !== 'string' ||
            !/^[a-f0-9]{40}$/i.test(entry.commit.sha)) {
          throw new Error('GITHUB_BRANCH_LIST_INVALID');
        }
        branches.push({ name: entry.name, sha: entry.commit.sha });
      }
      if (data.length < 100) return branches;
    }
    throw new Error('GITHUB_BRANCH_LIST_LIMIT');
  }

  private async getJson(token: string, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'agent-cluster',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
    } catch {
      throw new Error('GITHUB_API_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`GITHUB_API_HTTP_${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error('GITHUB_API_RESPONSE_INVALID');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
