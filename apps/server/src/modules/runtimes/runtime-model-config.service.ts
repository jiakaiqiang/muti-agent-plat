import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  RuntimeModelConfig,
  RuntimeModelCreateInput,
  RuntimeModelKind,
  RuntimeModelOption,
  RuntimeModelProvider,
  RuntimeCredentialLocation,
  RuntimeModelSource,
  RuntimeModelUpdateInput
} from '@agent-cluster/shared';
import { runtimeTypesForModelProvider } from '@agent-cluster/shared';
import {
  genericLlmMockFallbackEnabled,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmProvider
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { decodeSecret, encodeSecret } from '../../common/secret-cipher.js';
import { PersistenceService } from '../persistence/persistence.service.js';

type PersistedRuntimeModelOption = {
  id: string;
  label: string;
  provider: RuntimeModelProvider;
  source: RuntimeModelSource;
  kind: RuntimeModelKind;
  credentialLocation?: RuntimeCredentialLocation;
  deviceId?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  createdAt: string;
  updatedAt: string;
};

type PersistedRuntimeModelConfig = {
  currentModelId?: string;
  models?: PersistedRuntimeModelOption[];
  updatedAt?: string;
};

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

export type RuntimeModelConnection = {
  id: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  kind: RuntimeModelKind;
  provider: RuntimeModelProvider;
  credentialLocation: RuntimeCredentialLocation;
  deviceId?: string;
};

const collectionKey = 'runtimeModelConfig';
const localDefaultBaseUrl = 'http://127.0.0.1:11434/v1';

@Injectable()
export class RuntimeModelConfigService {
  private config: PersistedRuntimeModelConfig;
  private localDiscoveredModels: string[] = [];
  private localDiscoveryLoadedAt = 0;

  constructor(private readonly persistence: PersistenceService) {
    const stored = this.persistence.getCollection<PersistedRuntimeModelConfig>(collectionKey, {});
    this.assertCurrentSchema(stored);
    this.config = revealPersistedConfig(stored);
    this.persist();
  }

  async getConfig(): Promise<RuntimeModelConfig> {
    await this.refreshLocalModels();
    return this.buildConfig();
  }

  getConfigSnapshot(): RuntimeModelConfig {
    return this.buildConfig();
  }

  private buildConfig(): RuntimeModelConfig {
    const provider = llmProvider();
    const defaultModel = llmModel();
    const availableModelsWithoutAgents = this.availableModels();
    const currentModelId = this.normalizeModelId(this.config.currentModelId) ?? this.defaultModelId(defaultModel);
    const selectedModelOption =
      availableModelsWithoutAgents.find((model) => model.id === currentModelId) ??
      availableModelsWithoutAgents.find((model) => model.id === this.defaultModelId(defaultModel)) ??
      availableModelsWithoutAgents[0] ??
      this.toOption(this.createConfiguredModel(defaultModel, 'env', provider));
    const availableModels = availableModelsWithoutAgents;
    const currentModelOption = selectedModelOption;

    return {
      provider: currentModelOption.provider,
      baseUrl: this.resolveBaseUrl(currentModelOption),
      currentModelId: currentModelOption.id,
      currentModel: currentModelOption.model,
      defaultModel,
      currentModelOption,
      availableModels,
      mockFallbackEnabled: genericLlmMockFallbackEnabled(),
      updatedAt: this.config.updatedAt
    };
  }

  currentModel() {
    return this.currentConnection().model;
  }

  currentConnection(): RuntimeModelConnection {
    return this.connectionForModelId(this.getConfigSnapshot().currentModelOption.id);
  }

  connectionForModelId(modelId?: string): RuntimeModelConnection {
    const currentConfig = this.getConfigSnapshot();
    const option =
      (modelId ? currentConfig.availableModels.find((model) => model.id === modelId) : undefined) ??
      currentConfig.currentModelOption;
    const persisted = this.config.models?.find((model) => model.id === option.id);
    return {
      id: option.id,
      model: option.model,
      baseUrl: persisted?.baseUrl ?? this.resolveBaseUrl(option),
      apiKey: (persisted?.credentialLocation ?? option.credentialLocation) === 'local'
        ? undefined
        : persisted?.apiKey ?? this.resolveApiKey(option),
      kind: option.kind,
      provider: option.provider,
      credentialLocation: option.credentialLocation,
      ...(option.deviceId ? { deviceId: option.deviceId } : {})
    };
  }

  async switchModel(modelIdOrModel: string): Promise<RuntimeModelConfig> {
    const normalized = this.normalizeModelId(modelIdOrModel);
    if (!normalized) {
      throw new BadRequestException('Model id is required.');
    }

    const current = await this.getConfig();
    const option =
      current.availableModels.find((item) => item.id === normalized) ??
      current.availableModels.find((item) => item.model === normalized);

    if (!option) {
      throw new BadRequestException(`Model is not configured: ${normalized}`);
    }

    this.config = {
      ...this.config,
      currentModelId: option.id,
      updatedAt: nowIso()
    };
    this.persist();
    return this.getConfig();
  }

  async addModel(input: RuntimeModelCreateInput): Promise<RuntimeModelConfig> {
    const model = this.normalizeModelId(input.model);
    if (!model) {
      throw new BadRequestException('Model name is required.');
    }

    if (input.kind === 'remote') {
      const baseUrl = this.normalizeBaseUrl(input.baseUrl);
      const apiKey = input.apiKey?.trim();
      const provider = input.provider ?? 'openai-compatible';
      const credentialLocation = input.credentialLocation ?? 'server';
      if (!baseUrl) {
        throw new BadRequestException('Remote model base URL is required.');
      }
      if (!apiKey) {
        throw new BadRequestException('Remote model API key is required.');
      }
      if (credentialLocation === 'local' && !input.deviceId?.trim()) {
        throw new BadRequestException('A local credential requires a Local Runtime device id.');
      }
      this.upsertModel({
        kind: 'remote',
        source: 'remote',
        provider,
        credentialLocation,
        deviceId: input.deviceId?.trim(),
        model,
        label: input.label?.trim() || model,
        baseUrl,
        ...(credentialLocation === 'server' ? { apiKey } : { hasApiKey: true })
      });
    } else {
      this.upsertModel({
        kind: 'local',
        source: 'local',
        provider: 'ollama',
        credentialLocation: 'server',
        model,
        label: input.label?.trim() || model,
        baseUrl: this.localBaseUrl()
      });
    }

    return this.getConfig();
  }

  async updateModel(modelId: string, input: RuntimeModelUpdateInput): Promise<RuntimeModelConfig> {
    const id = this.normalizeModelId(modelId);
    const existing = id ? this.config.models?.find((model) => model.id === id) : undefined;
    if (!id || !existing) {
      throw new BadRequestException('Only models added via model management can be edited.');
    }

    const model = input.model !== undefined ? this.normalizeModelId(input.model) : existing.model;
    if (!model) {
      throw new BadRequestException('Model name is required.');
    }
    const label = input.label !== undefined ? input.label.trim() || model : existing.label;
    const provider = input.provider ?? existing.provider ?? (existing.kind === 'local' ? 'ollama' : 'openai-compatible');
    const credentialLocation = input.credentialLocation ?? existing.credentialLocation ?? 'server';
    const deviceId = input.deviceId !== undefined ? input.deviceId.trim() || undefined : existing.deviceId;
    if (existing.kind === 'remote' && credentialLocation === 'local' && !deviceId) {
      throw new BadRequestException('A local credential requires a Local Runtime device id.');
    }

    let baseUrl = existing.baseUrl;
    let apiKey = existing.apiKey;
    if (existing.kind === 'remote') {
      baseUrl = input.baseUrl !== undefined ? this.normalizeBaseUrl(input.baseUrl) : existing.baseUrl;
      if (!baseUrl) {
        throw new BadRequestException('Remote model base URL is required.');
      }
      if (credentialLocation === 'server' && input.apiKey !== undefined && input.apiKey.trim()) {
        apiKey = input.apiKey.trim();
      }
      if (credentialLocation === 'server' && !apiKey) {
        throw new BadRequestException('Remote model API key is required.');
      }
    }

    const now = nowIso();
    // model/baseUrl 参与 id 生成,编辑它们会产生新 id,需要同步迁移 currentModelId
    const nextId = this.modelId(existing.kind, model, existing.kind === 'remote' ? baseUrl : existing.baseUrl, provider, credentialLocation, deviceId);
    const next: PersistedRuntimeModelOption = {
      ...existing,
      id: nextId,
      model,
      label,
      provider,
      credentialLocation,
      deviceId,
      baseUrl,
      apiKey: credentialLocation === 'server' ? apiKey : undefined,
      hasApiKey: credentialLocation === 'local' ? (input.apiKey?.trim() ? true : existing.hasApiKey) : undefined,
      updatedAt: now
    };
    this.config = {
      ...this.config,
      currentModelId: this.config.currentModelId === id ? nextId : this.config.currentModelId,
      models: [...(this.config.models ?? []).filter((item) => item.id !== id && item.id !== nextId), next],
      updatedAt: now
    };
    this.persist();
    return this.getConfig();
  }

  async deleteModel(modelId: string): Promise<RuntimeModelConfig> {
    const id = this.normalizeModelId(modelId);
    const existing = id ? this.config.models?.find((model) => model.id === id) : undefined;
    if (!id || !existing) {
      throw new BadRequestException('Only models added via model management can be deleted.');
    }

    this.config = {
      ...this.config,
      // 当前模型被删除时清空指向,buildConfig 会回落到 .env 配置的默认模型
      currentModelId: this.config.currentModelId === id ? undefined : this.config.currentModelId,
      models: (this.config.models ?? []).filter((item) => item.id !== id),
      updatedAt: nowIso()
    };
    this.persist();
    return this.getConfig();
  }

  private availableModels(): RuntimeModelOption[] {
    const byId = new Map<string, RuntimeModelOption>();
    const add = (option: RuntimeModelOption) => {
      if (!option.id || byId.has(option.id)) {
        return;
      }
      byId.set(option.id, option);
    };

    for (const model of this.localDiscoveredModels) {
      add(this.toOption(this.createDiscoveredLocalModel(model)));
    }
    for (const model of this.config.models ?? []) {
      add(this.toOption(model));
    }
    // .env 配置的默认模型必须始终在列表中:否则 currentModelId 指向它时
    // 找不到匹配项,会命中 availableModels[0] 回落,被本地发现的模型静默顶掉。
    // 放在最后添加,同 id 的用户添加条目(自带 label/apiKey)优先。
    add(this.toOption(this.createConfiguredModel(llmModel(), 'env', llmProvider())));

    return [...byId.values()];
  }

  private upsertModel(input: {
    kind: RuntimeModelKind;
    source: Extract<RuntimeModelSource, 'local' | 'remote'>;
    provider: RuntimeModelProvider;
    credentialLocation: RuntimeCredentialLocation;
    deviceId?: string;
    model: string;
    label: string;
    baseUrl?: string;
    apiKey?: string;
    hasApiKey?: boolean;
  }) {
    const now = nowIso();
    const existingModels = this.config.models ?? [];
    const id = this.modelId(input.kind, input.model, input.baseUrl, input.provider, input.credentialLocation, input.deviceId);
    const existing = existingModels.find((model) => model.id === id);
    const next: PersistedRuntimeModelOption = {
      id,
      provider: input.provider,
      credentialLocation: input.credentialLocation,
      deviceId: input.deviceId,
      source: input.source,
      kind: input.kind,
      model: input.model,
      label: input.label,
      baseUrl: input.baseUrl,
      apiKey: input.credentialLocation === 'server' ? input.apiKey : undefined,
      hasApiKey: input.hasApiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    this.config = {
      ...this.config,
      currentModelId: id,
      models: [...existingModels.filter((model) => model.id !== id), next],
      updatedAt: now
    };
    this.persist();
  }

  private createConfiguredModel(
    model: string,
    source: Extract<RuntimeModelSource, 'env' | 'default'>,
    provider: RuntimeModelProvider
  ): PersistedRuntimeModelOption {
    const now = nowIso();
    const kind = provider === 'ollama' ? 'local' : 'remote';
    return {
      id: this.modelId(kind, model, provider === 'ollama' ? this.localBaseUrl() : llmBaseUrl()),
      label: model,
      provider,
      source,
      kind,
      credentialLocation: 'server',
      model,
      baseUrl: provider === 'ollama' ? this.localBaseUrl() : llmBaseUrl(),
      createdAt: now,
      updatedAt: now
    };
  }

  private createDiscoveredLocalModel(model: string): PersistedRuntimeModelOption {
    const now = nowIso();
    return {
      id: this.modelId('local', model, this.localBaseUrl()),
      label: model,
      provider: 'ollama',
      source: 'local',
      kind: 'local',
      credentialLocation: 'server',
      model,
      baseUrl: this.localBaseUrl(),
      createdAt: now,
      updatedAt: now
    };
  }

  private toOption(model: PersistedRuntimeModelOption): RuntimeModelOption {
    return {
      id: model.id,
      label: model.label,
      provider: model.provider,
      source: model.source,
      kind: model.kind,
      credentialLocation: model.credentialLocation ?? 'server',
      ...(model.deviceId ? { deviceId: model.deviceId } : {}),
      compatibleRuntimeTypes: runtimeTypesForModelProvider(model.provider ?? (model.kind === 'local' ? 'ollama' : 'openai-compatible')),
      model: model.model,
      baseUrl: model.baseUrl,
      hasApiKey: model.kind === 'remote'
        ? Boolean(model.hasApiKey ?? model.apiKey ?? (model.credentialLocation === 'local' ? false : llmApiKey()))
        : false,
      persisted: (this.config.models ?? []).some((item) => item.id === model.id),
      createdAt: model.createdAt,
      updatedAt: model.updatedAt
    };
  }

  private assertCurrentSchema(config: PersistedRuntimeModelConfig) {
    const record = config as unknown as Record<string, unknown>;
    if ('currentModel' in record || 'customModels' in record) {
      throw new Error('CUTOVER_REQUIRED: Runtime model configuration uses a legacy schema.');
    }
    const hasAgentBindings = Array.isArray(record.models) && record.models.some(
      (model) => Boolean(model) && typeof model === 'object' && 'agents' in model
    );
    if (hasAgentBindings) {
      throw new Error('CUTOVER_REQUIRED: Runtime model configuration contains legacy Agent bindings.');
    }
  }

  private modelId(
    kind: RuntimeModelKind,
    model: string,
    baseUrl?: string,
    provider: RuntimeModelProvider = kind === 'local' ? 'ollama' : 'openai-compatible',
    credentialLocation: RuntimeCredentialLocation = 'server',
    deviceId?: string
  ) {
    const endpoint = kind === 'remote' ? this.normalizeBaseUrl(baseUrl) ?? 'remote' : 'local';
    return `${kind}:${provider}:${credentialLocation}:${this.slug(deviceId ?? endpoint)}:${this.slug(model)}`;
  }

  private defaultModelId(model: string) {
    const provider = llmProvider();
    return this.modelId(provider === 'ollama' ? 'local' : 'remote', model, provider === 'ollama' ? this.localBaseUrl() : llmBaseUrl(), provider);
  }

  private normalizeModelId(value?: string) {
    const normalized = value?.trim();
    return normalized || undefined;
  }

  private normalizeBaseUrl(value?: string) {
    return value?.trim().replace(/\/$/, '') || undefined;
  }

  private resolveBaseUrl(option: RuntimeModelOption) {
    if (option.kind === 'local') {
      return option.baseUrl ?? this.localBaseUrl();
    }
    return option.baseUrl ?? llmBaseUrl();
  }

  private resolveApiKey(option: RuntimeModelOption) {
    return option.kind === 'local' ? 'ollama' : llmApiKey();
  }

  private localBaseUrl() {
    return llmProvider() === 'ollama' ? llmBaseUrl() ?? localDefaultBaseUrl : localDefaultBaseUrl;
  }

  private async refreshLocalModels() {
    const now = Date.now();
    if (now - this.localDiscoveryLoadedAt < 10_000) {
      return;
    }
    this.localDiscoveryLoadedAt = now;
    try {
      const response = await fetch(`${this.localBaseUrl().replace(/\/v1$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(1500)
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as OllamaTagsResponse;
      this.localDiscoveredModels = Array.from(
        new Set((body.models ?? []).map((model) => model.name ?? model.model).filter((model): model is string => Boolean(model)))
      );
    } catch {
      // Local Ollama discovery is best-effort; configured and default models still render.
    }
  }

  private slug(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  private persist() {
    this.persistence.setCollection(collectionKey, obfuscatePersistedConfig(this.config));
  }
}

function obfuscatePersistedConfig(config: PersistedRuntimeModelConfig): PersistedRuntimeModelConfig {
  if (!config.models) return config;
  return {
    ...config,
    models: config.models.map((model) =>
      model.apiKey ? { ...model, apiKey: encodeSecret(model.apiKey) } : model
    )
  };
}

function revealPersistedConfig(config: PersistedRuntimeModelConfig): PersistedRuntimeModelConfig {
  if (!config.models) return config;
  return {
    ...config,
    models: config.models.map((model) =>
      model.apiKey ? { ...model, apiKey: decodeSecret(model.apiKey) } : model
    )
  };
}
