import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ModelConnection, ModelProvider, ModelSource, RuntimeType } from '@agent-cluster/shared';
import { llmBaseUrl, llmProvider } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SecretsService } from './secrets.service.js';

// Stable id for the env-derived default connection. Seed-only: re-derived from LLM_* on boot and
// never persisted, so changing the environment still takes effect on the next start.
const DEFAULT_CONNECTION_ID = '00000000-0000-0000-0000-0000000000c1';

export type ConnectionInput = {
  name?: string;
  source?: ModelSource;
  provider?: ModelProvider;
  runtimeType?: RuntimeType;
  baseUrl?: string;
  // Plaintext on the way in; encrypted before it is stored. null/'' clears it.
  credential?: string | null;
};

// Persisted shape: the public ModelConnection plus the secret material, which never leaves this service.
type StoredConnection = Omit<ModelConnection, 'hasCredential'> & {
  encryptedCredential?: string;
  credentialEnvRef?: string;
};

@Injectable()
export class ConnectionsService {
  private readonly connections = new Map<string, StoredConnection>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly secrets: SecretsService
  ) {
    const persisted = this.persistence.getCollection<StoredConnection[]>('modelConnections', []);
    const userConnections = persisted.filter((connection) => connection.id !== DEFAULT_CONNECTION_ID);
    for (const connection of [this.buildDefaultConnection(), ...userConnections]) {
      this.connections.set(connection.id, connection);
    }
    this.persist();
  }

  list(): ModelConnection[] {
    return [...this.connections.values()].map((connection) => this.sanitize(connection));
  }

  get(id: string): ModelConnection {
    return this.sanitize(this.getRaw(id));
  }

  getRaw(id: string): StoredConnection {
    const connection = this.connections.get(id);
    if (!connection) {
      throw new NotFoundException(`Connection not found: ${id}`);
    }
    return connection;
  }

  getDefault(): StoredConnection {
    return this.connections.get(DEFAULT_CONNECTION_ID) ?? this.buildDefaultConnection();
  }

  has(id: string) {
    return this.connections.has(id);
  }

  create(input: ConnectionInput): ModelConnection {
    const name = input.name?.trim();
    const baseUrl = input.baseUrl?.trim();
    const source = input.source ?? 'custom';
    const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
    if (!name) {
      throw new BadRequestException('Connection name is required');
    }
    if (!baseUrl) {
      throw new BadRequestException('Connection baseUrl is required');
    }
    if (source === 'official' && !credential) {
      throw new BadRequestException('Official connections require an API key');
    }
    const now = nowIso();
    const stored: StoredConnection = {
      id: crypto.randomUUID(),
      name,
      source,
      provider: input.provider ?? 'openai-compatible',
      runtimeType: input.runtimeType ?? 'generic_llm',
      baseUrl,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      encryptedCredential: credential ? this.secrets.encrypt(credential) : undefined
    };
    this.connections.set(stored.id, stored);
    this.persist();
    return this.sanitize(stored);
  }

  update(id: string, input: ConnectionInput): ModelConnection {
    const current = this.getRaw(id);
    if (current.isDefault) {
      throw new BadRequestException('The default connection is environment-managed and cannot be edited');
    }
    const next: StoredConnection = {
      ...current,
      name: input.name?.trim() || current.name,
      source: input.source ?? current.source,
      provider: input.provider ?? current.provider,
      runtimeType: input.runtimeType ?? current.runtimeType,
      baseUrl: input.baseUrl?.trim() || current.baseUrl,
      updatedAt: nowIso()
    };
    if (input.credential === null || input.credential === '') {
      next.encryptedCredential = undefined;
    } else if (typeof input.credential === 'string') {
      next.encryptedCredential = this.secrets.encrypt(input.credential.trim());
    }
    if (next.source === 'official' && !next.encryptedCredential) {
      throw new BadRequestException('Official connections require an API key');
    }
    this.connections.set(next.id, next);
    this.persist();
    return this.sanitize(next);
  }

  remove(id: string) {
    const connection = this.getRaw(id);
    if (connection.isDefault) {
      throw new BadRequestException('The default connection cannot be deleted');
    }
    this.connections.delete(id);
    this.persist();
    return { id, removed: true };
  }

  /** Resolves the usable credential (decrypted, env-backed, or provider default). Server-side only. */
  getCredential(id: string): string | undefined {
    const connection = this.connections.get(id);
    if (!connection) {
      return undefined;
    }
    if (connection.encryptedCredential) {
      try {
        return this.secrets.decrypt(connection.encryptedCredential);
      } catch {
        return undefined;
      }
    }
    if (connection.credentialEnvRef) {
      const fromEnv = process.env[connection.credentialEnvRef]?.trim();
      if (fromEnv) {
        return fromEnv;
      }
    }
    return connection.provider === 'ollama' ? 'ollama' : undefined;
  }

  /** Lists upstream model ids available on the connection's endpoint. */
  async discover(id: string): Promise<string[]> {
    const connection = this.getRaw(id);
    const key = this.getCredential(id);
    const url = `${connection.baseUrl.replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new BadRequestException(`Discovery failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string }>;
    };
    const fromOpenAi = (body.data ?? []).map((model) => model.id).filter((value): value is string => Boolean(value));
    const fromOllamaTags = (body.models ?? []).map((model) => model.name).filter((value): value is string => Boolean(value));
    return [...new Set([...fromOpenAi, ...fromOllamaTags])];
  }

  private sanitize(connection: StoredConnection): ModelConnection {
    const { encryptedCredential, credentialEnvRef, ...rest } = connection;
    const hasEnv = Boolean(credentialEnvRef && process.env[credentialEnvRef]?.trim());
    return { ...rest, hasCredential: Boolean(encryptedCredential) || hasEnv };
  }

  private buildDefaultConnection(): StoredConnection {
    const provider: ModelProvider = llmProvider() === 'ollama' ? 'ollama' : 'openai-compatible';
    const source: ModelSource = provider === 'ollama' ? 'local' : 'official';
    const now = nowIso();
    return {
      id: DEFAULT_CONNECTION_ID,
      name: provider === 'ollama' ? '本地 Ollama(默认)' : '默认连接',
      source,
      provider,
      runtimeType: 'generic_llm',
      baseUrl: llmBaseUrl() ?? '',
      isDefault: true,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      credentialEnvRef: 'LLM_API_KEY'
    };
  }

  private persist() {
    this.persistence.setCollection(
      'modelConnections',
      [...this.connections.values()].filter((connection) => !connection.isDefault)
    );
  }
}
