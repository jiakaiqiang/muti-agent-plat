import type { LocalRuntimeCapabilityStatus, RuntimeType } from '@agent-cluster/shared';
import type { LocalRuntimeAdapter, SupportedLocalRuntimeType } from './adapter.js';
import { ClaudeCodeLocalRuntimeAdapter } from './claude-code-adapter.js';
import { CodexLocalRuntimeAdapter } from './codex-adapter.js';

const adapters: readonly LocalRuntimeAdapter[] = [
  new CodexLocalRuntimeAdapter(),
  new ClaudeCodeLocalRuntimeAdapter()
];

const adapterByType = new Map(adapters.map((adapter) => [adapter.runtimeType, adapter]));

export function getLocalRuntimeAdapter(runtimeType: RuntimeType) {
  const adapter = adapterByType.get(runtimeType as SupportedLocalRuntimeType);
  if (!adapter) throw new Error(`LOCAL_RUNTIME_UNSUPPORTED: ${runtimeType} is not implemented by this CLI.`);
  return adapter;
}

export async function detectAvailableLocalRuntimes() {
  const capabilities = await probeLocalRuntimeCapabilities();
  return Object.fromEntries(
    capabilities
      .filter((capability): capability is LocalRuntimeCapabilityStatus & { version: string } => (
        capability.status === 'ready' && Boolean(capability.version)
      ))
      .map((capability) => [capability.runtimeType, capability.version] as const)
  ) as Partial<Record<SupportedLocalRuntimeType, string>>;
}

export async function probeLocalRuntimeCapabilities(): Promise<LocalRuntimeCapabilityStatus[]> {
  const checkedAt = new Date().toISOString();
  return Promise.all(adapters.map(async (adapter) => {
    try {
      const version = await adapter.detectVersion();
      return version
        ? { runtimeType: adapter.runtimeType, status: 'ready' as const, version, checkedAt }
        : {
            runtimeType: adapter.runtimeType,
            status: 'not_found' as const,
            reasonCode: 'RUNTIME_COMMAND_NOT_FOUND',
            checkedAt
          };
    } catch {
      return {
        runtimeType: adapter.runtimeType,
        status: 'probe_failed' as const,
        reasonCode: 'RUNTIME_VERSION_PROBE_FAILED',
        checkedAt
      };
    }
  }));
}
