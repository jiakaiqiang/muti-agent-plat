import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ModelDefaults,
  ModelDefinition,
  ModelFeatureFlags,
  ResolvedRuntimeModel,
  RuntimeAgentProfile
} from '@agent-cluster/shared';
import { llmModel } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ConnectionsService } from './connections.service.js';

// Seed-only env default, mirroring the default connection. Always re-derived from env, never persisted.
const DEFAULT_MODEL_ID = '00000000-0000-0000-0000-0000000000d1';
const DEFAULT_CONNECTION_ID = '00000000-0000-0000-0000-0000000000c1';

const defaultFeatures: ModelFeatureFlags = { toolCalling: true, vision: false, jsonMode: true, contextWindow: 0 };

export type ModelInput = {
  connectionId?: string;
  name?: string;
  upstreamModel?: string;
  features?: Partial<ModelFeatureFlags>;
  defaults?: ModelDefaults;
  status?: 'active' | 'disabled';
};

@Injectable()
export class ModelsService {
  private readonly models = new Map<string, ModelDefinition>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly connections: ConnectionsService
  ) {
    const persisted = this.persistence.getCollection<ModelDefinition[]>('models', []);
    const userModels = persisted.filter((model) => model.id !== DEFAULT_MODEL_ID);
    for (const model of [this.buildDefaultModel(), ...userModels]) {
      this.models.set(model.id, model);
    }
    this.persist();
  }

  list() {
    return [...this.models.values()];
  }

  get(id: string) {
    const model = this.models.get(id);
    if (!model) {
      throw new NotFoundException(`Model not found: ${id}`);
    }
    return model;
  }

  getDefault() {
    return this.models.get(DEFAULT_MODEL_ID) ?? this.buildDefaultModel();
  }

  create(input: ModelInput): ModelDefinition {
    const connectionId = input.connectionId?.trim();
    if (!connectionId || !this.connections.has(connectionId)) {
      throw new BadRequestException('A valid connectionId is required');
    }
    const upstreamModel = input.upstreamModel?.trim();
    if (!upstreamModel) {
      throw new BadRequestException('upstreamModel is required');
    }
    const now = nowIso();
    const model: ModelDefinition = {
      id: crypto.randomUUID(),
      connectionId,
      name: input.name?.trim() || upstreamModel,
      upstreamModel,
      features: { ...defaultFeatures, ...input.features },
      defaults: input.defaults,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now
    };
    this.models.set(model.id, model);
    this.persist();
    return model;
  }

  update(id: string, input: ModelInput): ModelDefinition {
    const current = this.get(id);
    if (current.isDefault) {
      throw new BadRequestException('The default model is environment-managed and cannot be edited');
    }
    if (input.connectionId && !this.connections.has(input.connectionId)) {
      throw new BadRequestException('A valid connectionId is required');
    }
    const updated: ModelDefinition = {
      ...current,
      connectionId: input.connectionId ?? current.connectionId,
      name: input.name?.trim() || current.name,
      upstreamModel: input.upstreamModel?.trim() || current.upstreamModel,
      features: input.features ? { ...current.features, ...input.features } : current.features,
      defaults: input.defaults ?? current.defaults,
      status: input.status ?? current.status,
      updatedAt: nowIso()
    };
    this.models.set(updated.id, updated);
    this.persist();
    return updated;
  }

  remove(id: string) {
    const model = this.get(id);
    if (model.isDefault) {
      throw new BadRequestException('The default model cannot be deleted');
    }
    this.models.delete(id);
    this.persist();
    return { id, removed: true };
  }

  /** Resolves the model + connection an agent should run on, falling back to the env default. */
  resolveForAgent(agent: Pick<RuntimeAgentProfile, 'modelId'>): ResolvedRuntimeModel {
    let model = this.getDefault();
    if (agent.modelId) {
      const candidate = this.models.get(agent.modelId);
      if (candidate && candidate.status === 'active') {
        model = candidate;
      }
    }
    const connection = this.connections.has(model.connectionId)
      ? this.connections.getRaw(model.connectionId)
      : this.connections.getDefault();
    return {
      modelId: model.id,
      connectionId: connection.id,
      source: connection.source,
      provider: connection.provider,
      runtimeType: connection.runtimeType,
      baseUrl: connection.baseUrl,
      upstreamModel: model.upstreamModel,
      features: model.features,
      defaults: model.defaults
    };
  }

  private buildDefaultModel(): ModelDefinition {
    const now = nowIso();
    return {
      id: DEFAULT_MODEL_ID,
      connectionId: DEFAULT_CONNECTION_ID,
      name: '默认模型',
      upstreamModel: llmModel(),
      features: defaultFeatures,
      defaults: { temperature: 0.2 },
      status: 'active',
      isDefault: true,
      createdAt: now,
      updatedAt: now
    };
  }

  private persist() {
    this.persistence.setCollection(
      'models',
      this.list().filter((model) => !model.isDefault)
    );
  }
}
