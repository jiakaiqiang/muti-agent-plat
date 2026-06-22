import { Injectable, Logger } from '@nestjs/common';
import type { AgentRuntimeAdapter, RuntimeAdapterCategory, RuntimeType } from '@agent-cluster/shared';
import { RuntimeRegistryService } from './runtime-registry.service.js';

export type RuntimeSmartRouterOptions = {
  preferredRuntimeType?: RuntimeType;
  preferInternal?: boolean;
  excludeRuntimeTypes?: RuntimeType[];
  allowFallback?: boolean;
};

export type RuntimeSmartRouterSelection = {
  adapter: AgentRuntimeAdapter;
  reason: string;
  fallbackUsed: boolean;
};

@Injectable()
export class RuntimeSmartRouterService {
  private readonly logger = new Logger(RuntimeSmartRouterService.name);

  constructor(private readonly registry: RuntimeRegistryService) {}

  /** Select the best runtime for required capabilities with explicit fallback reasons. */
  async selectRuntime(
    requiredCapabilityIds: string[],
    options: RuntimeSmartRouterOptions = {}
  ): Promise<RuntimeSmartRouterSelection> {
    this.logger.log(`Selecting runtime for capabilities: ${requiredCapabilityIds.join(', ') || '(none)'}`);

    if (options.preferredRuntimeType) {
      const preferred = this.registry.getAdapter(options.preferredRuntimeType);
      if (preferred && (await this.isHealthy(preferred))) {
        return {
          adapter: preferred,
          reason: `preferred runtime is healthy: ${preferred.type}`,
          fallbackUsed: false
        };
      }

      if (options.allowFallback === false) {
        throw new Error(`Preferred runtime unavailable: ${options.preferredRuntimeType}`);
      }
    }

    if (options.preferInternal !== false) {
      const internal = await this.selectFromCategory('internal', requiredCapabilityIds, options.excludeRuntimeTypes);
      if (internal) {
        this.logger.log(`Selected internal runtime: ${internal.type}`);
        return {
          adapter: internal,
          reason: `selected healthy internal runtime: ${internal.type}`,
          fallbackUsed: true
        };
      }
    }

    const external = await this.selectFromCategory('external', requiredCapabilityIds, options.excludeRuntimeTypes);
    if (external) {
      this.logger.warn(`Falling back to external runtime: ${external.type}`);
      return {
        adapter: external,
        reason: `fallback to healthy external runtime: ${external.type}`,
        fallbackUsed: true
      };
    }

    const generic = this.registry.getAdapter('generic_llm');
    if (!generic) {
      throw new Error('No runtime available, including generic_llm fallback');
    }

    this.logger.error('No suitable runtime found, falling back to generic_llm');
    return {
      adapter: generic,
      reason: 'fallback to generic_llm',
      fallbackUsed: true
    };
  }

  private async selectFromCategory(
    category: RuntimeAdapterCategory,
    requiredCapabilityIds: string[],
    excludeRuntimeTypes: RuntimeType[] = []
  ): Promise<AgentRuntimeAdapter | undefined> {
    const excluded = new Set(excludeRuntimeTypes);
    const candidates = this.registry.listByCategory(category).filter((adapter) => {
      if (excluded.has(adapter.type)) {
        return false;
      }

      const capabilityIds = adapter.metadata?.capabilityIds ?? [];
      return requiredCapabilityIds.every((capabilityId) => capabilityIds.includes(capabilityId));
    });

    for (const candidate of candidates) {
      if (await this.isHealthy(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private async isHealthy(runtime: AgentRuntimeAdapter): Promise<boolean> {
    try {
      const health = runtime.healthCheck
        ? await runtime.healthCheck()
        : { status: 'healthy' as const, lastCheckAt: new Date().toISOString() };
      return health.status === 'healthy';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Health check failed for ${runtime.type}: ${message}`);
      return false;
    }
  }
}
