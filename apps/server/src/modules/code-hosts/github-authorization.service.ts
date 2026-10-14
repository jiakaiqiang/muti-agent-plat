import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decodeSecret, encodeSecret } from '../../common/secret-cipher.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { GitHubCodeHostAdapter } from './github-code-host.adapter.js';
import { normalizeGitHubRepositoryUrl } from './github-repository-url.js';

type GitHubAuthorizationRecord = {
  id: string;
  kind: 'pat' | 'github_app';
  accountId: string;
  accountLogin: string;
  accountEmail?: string;
  repositoryId: string;
  repositoryUrl: string;
  executionLocation: 'server';
  state: 'active' | 'invalid' | 'disconnected';
  version: number;
  secretEnvelope?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubAuthorizationView = Omit<GitHubAuthorizationRecord, 'secretEnvelope'>;

type PendingOAuthState = {
  stateHash: string;
  sessionId: string;
  repositoryUrl: string;
  executionLocation: 'server' | 'local';
  deviceId?: string;
  expiresAt: string;
};

@Injectable()
export class GitHubAuthorizationService {
  private request = fetch;
  private readonly consumingStates = new Set<string>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly github: GitHubCodeHostAdapter
  ) {}

  async saveServerPat(token: string, repositoryUrl: string): Promise<GitHubAuthorizationView> {
    if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token)) {
      throw new Error('GITHUB_TOKEN_INVALID');
    }
    return this.saveServerCredential('pat', token, repositoryUrl, () => encodeSecret(token));
  }

  async startServerOAuth(sessionId: string, repositoryUrl: string): Promise<string> {
    return this.startOAuth(sessionId, repositoryUrl, 'server');
  }

  async startLocalOAuth(sessionId: string, repositoryUrl: string, deviceId: string): Promise<string> {
    if (!deviceId) throw new Error('GITHUB_OAUTH_DEVICE_INVALID');
    return this.startOAuth(sessionId, repositoryUrl, 'local', deviceId);
  }

  private async startOAuth(sessionId: string, repositoryUrl: string,
    executionLocation: PendingOAuthState['executionLocation'], deviceId?: string): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new Error('GITHUB_OAUTH_SESSION_INVALID');
    }
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const state = randomBytes(32).toString('base64url');
    const stateHash = createHash('sha256').update(state).digest('hex');
    const next: PendingOAuthState = { stateHash, sessionId,
      repositoryUrl: repository.repositoryUrl, executionLocation,
      ...(deviceId ? { deviceId } : {}),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const records = this.pendingStates();
      const live = records.filter((item) => Date.parse(item.expiresAt) > Date.now());
      const result = await this.persistence.compareAndSetCollection('codeHostOAuthStates', records,
        [...live, next]);
      if (result.status === 'applied') return this.authorizationUrl(state);
      if (result.status === 'failed') throw new Error('GITHUB_OAUTH_STATE_PERSISTENCE_FAILED');
    }
    throw new Error('GITHUB_OAUTH_STATE_CONFLICT');
  }

  private authorizationUrl(state: string): string {
    const { clientId, callbackUrl } = this.oauthConfig();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    return url.href;
  }

  async exchangeOAuthCode(code: string, state: string): Promise<{
    executionLocation: 'server'; authorization: GitHubAuthorizationView;
    sessionId: string; repositoryUrl: string
  } | {
    executionLocation: 'local'; deviceId: string; accessToken: string;
    expiresAt?: string; sessionId: string; repositoryUrl: string
  }> {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(code) ||
        typeof state !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(state)) {
      throw new Error('GITHUB_OAUTH_CALLBACK_INVALID');
    }
    const binding = await this.consumeOAuthState(state);
    const { clientId, clientSecret, callbackUrl } = this.oauthConfig();
    const result = await this.exchangeToken({
      client_id: clientId, client_secret: clientSecret, code,
      redirect_uri: callbackUrl, state
    });
    const expiresAt = Number.isFinite(result.expires_in)
      ? new Date(Date.now() + Number(result.expires_in) * 1000).toISOString() : undefined;
    if (binding.executionLocation === 'local') {
      if (!binding.deviceId) throw new Error('GITHUB_OAUTH_DEVICE_INVALID');
      return { executionLocation: 'local', deviceId: binding.deviceId,
        accessToken: result.access_token, ...(expiresAt ? { expiresAt } : {}),
        sessionId: binding.sessionId, repositoryUrl: binding.repositoryUrl };
    }
    const secretEnvelope = encodeSecret(JSON.stringify({
      accessToken: result.access_token,
      ...(typeof result.refresh_token === 'string' ? { refreshToken: result.refresh_token } : {}),
      ...(Number.isFinite(result.refresh_token_expires_in)
        ? { refreshExpiresAt: new Date(Date.now() + Number(result.refresh_token_expires_in) * 1000).toISOString() }
        : {})
    }));
    const authorization = await this.saveServerCredential('github_app', result.access_token,
      binding.repositoryUrl, secretEnvelope, expiresAt);
    return { executionLocation: 'server', authorization,
      sessionId: binding.sessionId, repositoryUrl: binding.repositoryUrl };
  }

  private async consumeOAuthState(state: string): Promise<PendingOAuthState> {
    const stateHash = createHash('sha256').update(state).digest('hex');
    if (this.consumingStates.has(stateHash)) throw new Error('GITHUB_OAUTH_STATE_USED');
    this.consumingStates.add(stateHash);
    try {
      const records = this.pendingStates();
      const binding = records.find((item) => item.stateHash === stateHash);
      if (!binding || Date.parse(binding.expiresAt) <= Date.now()) {
        throw new Error('GITHUB_OAUTH_STATE_INVALID');
      }
      const result = await this.persistence.compareAndSetCollection('codeHostOAuthStates', records,
        records.filter((item) => item.stateHash !== stateHash));
      if (result.status !== 'applied') throw new Error('GITHUB_OAUTH_STATE_CONFLICT');
      return binding;
    } finally {
      this.consumingStates.delete(stateHash);
    }
  }

  private pendingStates(): PendingOAuthState[] {
    return this.persistence.getCollection<PendingOAuthState[]>('codeHostOAuthStates', []);
  }

  private async saveServerCredential(
    kind: GitHubAuthorizationRecord['kind'], token: string, repositoryUrl: string,
    secretEnvelope: string | (() => string), expiresAt?: string
  ): Promise<GitHubAuthorizationView> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const identity = await this.github.identify(token);
    const access = await this.github.inspectRepository(token, repository);
    const encodedSecret = typeof secretEnvelope === 'function' ? secretEnvelope() : secretEnvelope;
    const records = this.records();
    const previous = records.find((record) =>
      record.state === 'active' && record.kind === kind &&
      record.accountId === identity.id && record.repositoryId === access.id);
    const now = new Date().toISOString();
    const next: GitHubAuthorizationRecord = {
      id: previous?.id ?? randomUUID(), kind,
      accountId: identity.id, accountLogin: identity.login,
      ...(identity.email ? { accountEmail: identity.email } : {}),
      repositoryId: access.id, repositoryUrl: repository.repositoryUrl,
      executionLocation: 'server', state: 'active',
      version: (previous?.version ?? 0) + 1,
      secretEnvelope: encodedSecret, ...(expiresAt ? { expiresAt } : {}),
      createdAt: previous?.createdAt ?? now, updatedAt: now
    };
    const updated = previous
      ? records.map((record) => record.id === previous.id ? next : record)
      : [...records, next];
    if (!(await this.persistence.setCollection('codeHostAuthorizations', updated))) {
      throw new Error('GITHUB_AUTHORIZATION_PERSISTENCE_FAILED');
    }
    return this.publicView(next);
  }

  async findReusableServerAuthorization(repositoryUrl: string): Promise<GitHubAuthorizationView | undefined> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    for (const record of this.records()) {
      if (record.state !== 'active' || record.executionLocation !== 'server' ||
          record.repositoryUrl !== repository.repositoryUrl || !record.secretEnvelope) continue;
      let token: string;
      try {
        token = await this.tokenFor(record);
        const access = await this.github.inspectRepository(token, repository);
        if (access.id !== record.repositoryId) continue;
      } catch (error) {
        if (String(error).includes('GITHUB_API_HTTP_401')) await this.invalidate(record.id);
        continue;
      }
      return this.publicView(record);
    }
    return undefined;
  }

  async withServerToken<T>(
    authorizationId: string,
    repositoryUrl: string,
    operation: (token: string) => Promise<T>
  ): Promise<T> {
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const record = this.records().find((item) => item.id === authorizationId);
    if (record?.state !== 'active' || record.executionLocation !== 'server' ||
        record.repositoryUrl !== repository.repositoryUrl || !record.secretEnvelope) {
      throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    }
    return operation(await this.tokenFor(record));
  }

  private async tokenFor(record: GitHubAuthorizationRecord): Promise<string> {
    if (!record.secretEnvelope) throw new Error('GITHUB_AUTHORIZATION_UNAVAILABLE');
    const plaintext = decodeSecret(record.secretEnvelope);
    if (record.kind === 'pat') return plaintext;
    let payload: { accessToken?: string; refreshToken?: string; refreshExpiresAt?: string };
    try {
      payload = JSON.parse(plaintext);
    } catch {
      throw new Error('GITHUB_AUTHORIZATION_INVALID');
    }
    if (!payload.accessToken) throw new Error('GITHUB_AUTHORIZATION_INVALID');
    if (!record.expiresAt || Date.parse(record.expiresAt) > Date.now() + 60_000) return payload.accessToken;
    if (!payload.refreshToken ||
        (payload.refreshExpiresAt && Date.parse(payload.refreshExpiresAt) <= Date.now())) {
      throw new Error('GITHUB_AUTHORIZATION_EXPIRED');
    }
    const { clientId, clientSecret } = this.oauthConfig();
    const result = await this.exchangeToken({
      client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: payload.refreshToken
    });
    const refreshed: GitHubAuthorizationRecord = {
      ...record, version: record.version + 1,
      expiresAt: Number.isFinite(result.expires_in)
        ? new Date(Date.now() + Number(result.expires_in) * 1000).toISOString() : undefined,
      secretEnvelope: encodeSecret(JSON.stringify({
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? payload.refreshToken,
        ...(Number.isFinite(result.refresh_token_expires_in)
          ? { refreshExpiresAt: new Date(Date.now() + Number(result.refresh_token_expires_in) * 1000).toISOString() }
          : payload.refreshExpiresAt ? { refreshExpiresAt: payload.refreshExpiresAt } : {})
      })),
      updatedAt: new Date().toISOString()
    };
    if (!(await this.persistence.setCollection('codeHostAuthorizations',
      this.records().map((item) => item.id === record.id ? refreshed : item)))) {
      throw new Error('GITHUB_AUTHORIZATION_PERSISTENCE_FAILED');
    }
    return result.access_token;
  }

  private oauthConfig(): { clientId: string; clientSecret: string; callbackUrl: string } {
    const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
    const callbackUrl = process.env.GITHUB_APP_CALLBACK_URL?.trim();
    if (!clientId || !clientSecret || !callbackUrl) throw new Error('GITHUB_APP_OAUTH_NOT_CONFIGURED');
    let callback: URL;
    try { callback = new URL(callbackUrl); }
    catch { throw new Error('GITHUB_APP_CALLBACK_INVALID'); }
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
      throw new Error('GITHUB_APP_CALLBACK_INVALID');
    }
    return { clientId, clientSecret, callbackUrl: callback.href };
  }

  private async exchangeToken(input: Record<string, string>): Promise<{
    access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number
  }> {
    let response: Response;
    try {
      response = await this.request('https://github.com/login/oauth/access_token', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(input)
      });
    } catch {
      throw new Error('GITHUB_OAUTH_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`GITHUB_OAUTH_HTTP_${response.status}`);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error('GITHUB_OAUTH_RESPONSE_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        typeof (data as { access_token?: unknown }).access_token !== 'string') {
      throw new Error('GITHUB_OAUTH_RESPONSE_INVALID');
    }
    return data as { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
  }

  async disconnect(authorizationId: string): Promise<GitHubAuthorizationView> {
    const records = this.records();
    const record = records.find((item) => item.id === authorizationId);
    if (!record) throw new NotFoundException('GITHUB_AUTHORIZATION_NOT_FOUND');
    const updated: GitHubAuthorizationRecord = {
      ...record, state: 'disconnected', version: record.version + 1,
      secretEnvelope: undefined, updatedAt: new Date().toISOString()
    };
    if (!(await this.persistence.setCollection('codeHostAuthorizations',
      records.map((item) => item.id === authorizationId ? updated : item)))) {
      throw new Error('GITHUB_AUTHORIZATION_PERSISTENCE_FAILED');
    }
    return this.publicView(updated);
  }

  private async invalidate(authorizationId: string): Promise<void> {
    const records = this.records();
    const record = records.find((item) => item.id === authorizationId);
    if (!record || record.state !== 'active') return;
    await this.persistence.setCollection('codeHostAuthorizations', records.map((item) =>
      item.id === authorizationId
        ? { ...item, state: 'invalid' as const, version: item.version + 1, updatedAt: new Date().toISOString() }
        : item));
  }

  private records(): GitHubAuthorizationRecord[] {
    return this.persistence.getCollection<GitHubAuthorizationRecord[]>('codeHostAuthorizations', []);
  }

  private publicView(record: GitHubAuthorizationRecord): GitHubAuthorizationView {
    const { secretEnvelope: _secret, ...view } = record;
    return view;
  }
}
