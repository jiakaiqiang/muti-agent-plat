import { Injectable, Logger } from '@nestjs/common';
import type { AgentRuntimeAdapter, RuntimeAdapterCategory, RuntimeType } from '@agent-cluster/shared';

@Injectable()
export class RuntimeRegistryService {
  private readonly logger = new Logger(RuntimeRegistryService.name);
  private readonly adapters = new Map<RuntimeType, AgentRuntimeAdapter>();

  /** Register a Runtime Adapter when it is available for use. */
  async registerAdapter(adapter: AgentRuntimeAdapter): Promise<void> {
    const { available, reason } = adapter.checkAvailability
      ? await adapter.checkAvailability()
      : { available: true };

    if (!available) {
      this.logger.warn(`Runtime ${adapter.type} unavailable: ${reason ?? 'unknown reason'}`);
      return;
    }

    if (this.adapters.has(adapter.type)) {
      this.logger.warn(`Runtime registration overwritten: ${adapter.type}`);
    }
    this.adapters.set(adapter.type, adapter);
    this.logger.log(`Runtime registered: ${adapter.type}`);
  }

  /** Return a Runtime Adapter by its configured runtime type. */
  getAdapter(type: RuntimeType): AgentRuntimeAdapter | undefined {
    return this.adapters.get(type);
  }

  /** List Runtime Adapters that declare the requested category. */
  listByCategory(category: RuntimeAdapterCategory): AgentRuntimeAdapter[] {
    return [...this.adapters.values()].filter((adapter) => adapter.metadata?.category === category);
  }

  /** List all registered Runtime Adapters in registration order. */
  listAll(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  /** Remove a Runtime Adapter registration. */
  unregister(type: RuntimeType): boolean {
    const deleted = this.adapters.delete(type);
    if (deleted) {
      this.logger.log(`Runtime unregistered: ${type}`);
    }
    return deleted;
  }
}
