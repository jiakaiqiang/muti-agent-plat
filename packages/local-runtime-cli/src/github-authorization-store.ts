import { randomUUID } from 'node:crypto';
import { normalizeGitHubRepositoryUrl } from '@agent-cluster/shared';
import type { LocalGitHubAuthorizationRequest, LocalGitHubAuthorizationResult } from '@agent-cluster/shared';
import type { LocalGitHubAuthorization, LocalRuntimeState } from './state.js';
import { saveState } from './state.js';

type SecretStore = Pick<import('./local-secret-store.js').LocalSecretStore, 'set' | 'get' | 'delete'>;

export class LocalGitHubAuthorizationStore {
  constructor(
    private readonly state: LocalRuntimeState,
    private readonly secrets: SecretStore,
    private readonly request: typeof fetch = fetch,
    private readonly persist: (state: LocalRuntimeState) => Promise<void> = saveState
  ) {}

  async savePat(token: string, repositoryUrl: string): Promise<LocalGitHubAuthorization> {
    return this.saveCredential('pat', token, repositoryUrl);
  }

  async saveOAuth(token: string, repositoryUrl: string, expiresAt?: string): Promise<LocalGitHubAuthorization> {
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.now() + 60_000)) {
      throw new Error('GITHUB_AUTHORIZATION_EXPIRED');
    }
    return this.saveCredential('github_app', token, repositoryUrl, expiresAt);
  }

  private async saveCredential(kind: 'pat' | 'github_app', token: string,
    repositoryUrl: string, expiresAt?: string): Promise<LocalGitHubAuthorization> {
    if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token)) {
      throw new Error('GITHUB_TOKEN_INVALID');
    }
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const identity = await this.getJson(token, '/user');
    const access = await this.getJson(token, `/repos/${repository.repositoryId}`);
    if (!isRecord(identity) || !Number.isSafeInteger(identity.id) ||
        typeof identity.login !== 'string' || !identity.login ||
        !isRecord(access) || !Number.isSafeInteger(access.id) ||
        !isRecord(access.permissions) || access.permissions.push !== true) {
      throw new Error('GITHUB_REPOSITORY_WRITE_REQUIRED');
    }
    const accountId = String(identity.id);
    const repositoryId = String(access.id);
    const previous = this.state.githubAuthorizations?.find((item) => item.state === 'active' &&
      item.accountId === accountId && item.repositoryId === repositoryId);
    const now = new Date().toISOString();
    const record: LocalGitHubAuthorization = {
      id: previous?.id ?? randomUUID(), kind, deviceId: this.state.deviceId,
      accountId, accountLogin: identity.login,
      ...(typeof identity.email === 'string' && identity.email ? { accountEmail: identity.email } : {}),
      repositoryId, repositoryUrl: repository.repositoryUrl, state: 'active',
      ...(expiresAt ? { expiresAt } : {}),
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? now, updatedAt: now
    };
    await this.secrets.set(`github:${record.id}`, token);
    this.state.githubAuthorizations = previous
      ? this.state.githubAuthorizations!.map((item) => item.id === previous.id ? record : item)
      : [...(this.state.githubAuthorizations ?? []), record];
    await this.persist(this.state);
    return structuredClone(record);
  }

  async reusable(repositoryUrl: string): Promise<LocalGitHubAuthorization | undefined> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    for (const record of this.state.githubAuthorizations ?? []) {
      if (record.state !== 'active' || record.deviceId !== this.state.deviceId ||
          record.repositoryUrl !== repository.repositoryUrl ||
          record.expiresAt && Date.parse(record.expiresAt) <= Date.now() + 60_000) continue;
      const token = await this.secrets.get(`github:${record.id}`);
      if (!token) continue;
      try {
        const access = await this.getJson(token, `/repos/${repository.repositoryId}`);
        if (isRecord(access) && String(access.id) === record.repositoryId &&
            isRecord(access.permissions) && access.permissions.push === true) {
          return structuredClone(record);
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async withToken<T>(authorizationId: string, repositoryUrl: string,
    operation: (token: string) => Promise<T>): Promise<T> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const record = this.state.githubAuthorizations?.find((item) =>
      item.id === authorizationId && item.state === 'active' &&
      item.deviceId === this.state.deviceId && item.repositoryUrl === repository.repositoryUrl);
    if (!record) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now() + 60_000) {
      throw new Error('GITHUB_AUTHORIZATION_EXPIRED');
    }
    const token = await this.secrets.get(`github:${record.id}`);
    if (!token) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return operation(token);
  }

  identityFor(authorizationId: string, repositoryUrl: string): {
    accountId: string; accountLogin: string; accountEmail?: string
  } {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const record = this.state.githubAuthorizations?.find((item) =>
      item.id === authorizationId && item.state === 'active' &&
      item.deviceId === this.state.deviceId && item.repositoryUrl === repository.repositoryUrl);
    if (!record) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    return { accountId: record.accountId, accountLogin: record.accountLogin,
      ...(record.accountEmail ? { accountEmail: record.accountEmail } : {}) };
  }

  inspectRepository(authorizationId: string, repositoryUrl: string): Promise<{
    accountId: string; repositoryId: string; defaultBranch: string
  }> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    return this.withToken(authorizationId, repository.repositoryUrl, async (token) => {
      const record = this.state.githubAuthorizations!.find((item) => item.id === authorizationId)!;
      const access = await this.getJson(token, `/repos/${repository.repositoryId}`);
      if (!isRecord(access) || String(access.id) !== record.repositoryId ||
          !isRecord(access.permissions) || access.permissions.push !== true ||
          typeof access.default_branch !== 'string' || !access.default_branch) {
        throw new Error('GITHUB_REPOSITORY_WRITE_REQUIRED');
      }
      return { accountId: record.accountId, repositoryId: record.repositoryId,
        defaultBranch: access.default_branch };
    });
  }

  async disconnect(authorizationId: string, repositoryUrl?: string): Promise<LocalGitHubAuthorization> {
    const record = this.state.githubAuthorizations?.find((item) => item.id === authorizationId);
    if (!record || record.deviceId !== this.state.deviceId ||
        repositoryUrl && record.repositoryUrl !== normalizeGitHubRepositoryUrl(repositoryUrl).repositoryUrl) {
      throw new Error('GITHUB_AUTHORIZATION_NOT_FOUND');
    }
    await this.secrets.delete(`github:${record.id}`);
    const updated: LocalGitHubAuthorization = { ...record, state: 'disconnected',
      version: record.version + 1, updatedAt: new Date().toISOString() };
    this.state.githubAuthorizations = this.state.githubAuthorizations!.map((item) =>
      item.id === record.id ? updated : item);
    await this.persist(this.state);
    return structuredClone(updated);
  }

  private async getJson(token: string, path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'User-Agent': 'agent-runtime', 'X-GitHub-Api-Version': '2022-11-28' }
      });
    } catch {
      throw new Error('GITHUB_API_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`GITHUB_API_HTTP_${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('GITHUB_API_RESPONSE_INVALID'); }
  }
}

export async function handleLocalGitHubAuthorizationRequest(
  request: LocalGitHubAuthorizationRequest,
  store: LocalGitHubAuthorizationStore
): Promise<LocalGitHubAuthorizationResult> {
  try {
    const authorization = request.action === 'save_pat'
      ? await store.savePat(request.token, request.repositoryUrl)
      : request.action === 'save_oauth'
        ? await store.saveOAuth(request.token, request.repositoryUrl, request.expiresAt)
      : request.action === 'find_reusable'
        ? await store.reusable(request.repositoryUrl)
        : request.action === 'disconnect'
          ? await store.disconnect(request.authorizationId, request.repositoryUrl)
          : undefined;
    if (!['save_pat', 'save_oauth', 'find_reusable', 'disconnect'].includes(request.action)) {
      throw new Error('GITHUB_AUTHORIZATION_REQUEST_INVALID');
    }
    return { requestId: request.requestId, status: 'ok', ...(authorization ? { authorization } : {}) };
  } catch (error) {
    const code = error instanceof Error && /^GITHUB_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'GITHUB_AUTHORIZATION_FAILED';
    return { requestId: request.requestId, status: 'error', error: { code } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
