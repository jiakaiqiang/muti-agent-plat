import type { RuntimeType } from '@agent-cluster/shared';
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
  const versions = await Promise.all(adapters.map(async (adapter) => [adapter.runtimeType, await adapter.detectVersion()] as const));
  return Object.fromEntries(
    versions.filter((entry): entry is readonly [SupportedLocalRuntimeType, string] => Boolean(entry[1]))
  ) as Partial<Record<SupportedLocalRuntimeType, string>>;
}
