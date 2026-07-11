import type { ContextEnvelopeV2 } from '@agent-cluster/shared';

export interface DuplicateListingReport {
  hasDuplicates: boolean;
  duplicatedPaths: string[];
}

export function assertNoDuplicateFileListings(envelope: ContextEnvelopeV2): DuplicateListingReport {
  const manifestPaths = new Set<string>();
  for (const entry of envelope.L1.entries) {
    if (entry.kind === 'file') manifestPaths.add(entry.path);
  }

  const duplicated = new Set<string>();
  for (const module of envelope.L2.modules) {
    for (const path of module.entrypoints ?? []) {
      if (manifestPaths.has(path)) duplicated.add(path);
    }
    for (const path of module.tests ?? []) {
      if (manifestPaths.has(path)) duplicated.add(path);
    }
  }

  for (const evidence of envelope.L3.files) {
    if (manifestPaths.has(evidence.path)) duplicated.add(evidence.path);
  }

  return {
    hasDuplicates: duplicated.size > 0,
    duplicatedPaths: Array.from(duplicated).sort()
  };
}

export function pruneDuplicatePathsFromProjectMap(envelope: ContextEnvelopeV2): ContextEnvelopeV2 {
  const manifestPaths = new Set<string>();
  for (const entry of envelope.L1.entries) {
    if (entry.kind === 'file') manifestPaths.add(entry.path);
  }
  const prunedModules = envelope.L2.modules.map((module) => ({
    ...module,
    ...(module.entrypoints
      ? { entrypoints: module.entrypoints.filter((path) => !manifestPaths.has(path)) }
      : {}),
    ...(module.tests
      ? { tests: module.tests.filter((path) => !manifestPaths.has(path)) }
      : {})
  }));
  return {
    ...envelope,
    L2: { ...envelope.L2, modules: prunedModules }
  };
}
