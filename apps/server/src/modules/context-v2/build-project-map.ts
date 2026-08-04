import type {
  ContextL2ProjectMap,
  ContextL2ProjectMapModule,
  WorkspaceIndexEntry
} from '@agent-cluster/shared';

const TEST_SUFFIXES = ['.spec', '.test'] as const;

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / 4);
}

export interface BuildProjectMapArgs {
  entries: WorkspaceIndexEntry[];
  entrypoints: string[];
  detectedStack?: string[];
  source?: ContextL2ProjectMap['source'];
  budgetTokens?: number;
}

export function buildProjectMap(args: BuildProjectMapArgs): ContextL2ProjectMap {
  const { entries, entrypoints, detectedStack, source = 'generated', budgetTokens } = args;
  const eligible = entries.filter((entry) => !entry.generated && !entry.sensitive);
  const files = eligible.filter((entry) => entry.kind === 'file');

  const modulesByRoot = new Map<string, {
    paths: string[];
    entrypoints: Set<string>;
    tests: Set<string>;
  }>();

  const entrypointSet = new Set(entrypoints);

  for (const file of files) {
    const moduleRoot = topLevelSegment(file.path);
    let module = modulesByRoot.get(moduleRoot);
    if (!module) {
      module = { paths: [], entrypoints: new Set(), tests: new Set() };
      modulesByRoot.set(moduleRoot, module);
    }
    module.paths.push(file.path);
    if (entrypointSet.has(file.path)) module.entrypoints.add(file.path);
    if (isTestPath(file.path)) module.tests.add(file.path);
  }

  let modules: ContextL2ProjectMapModule[] = Array.from(modulesByRoot.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, info]) => ({
      name,
      path: name,
      responsibility: describeResponsibility(name),
      ...(info.entrypoints.size > 0 ? { entrypoints: Array.from(info.entrypoints).sort() } : {}),
      ...(info.tests.size > 0 ? { tests: Array.from(info.tests).sort() } : {})
    }));

  if (budgetTokens !== undefined) {
    let usedTokens = 0;
    const kept: ContextL2ProjectMapModule[] = [];
    for (const module of modules) {
      const moduleBytes = Buffer.byteLength(JSON.stringify(module), 'utf8');
      const moduleTokens = estimateTokens(moduleBytes);
      if (usedTokens + moduleTokens > budgetTokens && kept.length > 0) break;
      usedTokens += moduleTokens;
      kept.push(module);
    }
    modules = kept;
  }

  return {
    source,
    modules,
    ...(detectedStack && detectedStack.length > 0 ? { detectedStack } : {})
  };
}

function topLevelSegment(path: string): string {
  const first = path.split('/').filter(Boolean)[0];
  return first ?? '.';
}

function isTestPath(path: string): boolean {
  const basename = path.split('/').pop() ?? '';
  const withoutExt = basename.replace(/\.[^.]+$/, '');
  for (const suffix of TEST_SUFFIXES) {
    if (withoutExt.endsWith(suffix)) return true;
  }
  return path.includes('/__tests__/');
}

function describeResponsibility(name: string): string {
  if (name === 'apps') return 'application entrypoints';
  if (name === 'packages') return 'shared packages';
  if (name === 'src') return 'source code';
  if (name === 'docs') return 'documentation';
  if (name === 'scripts') return 'automation scripts';
  return 'project module';
}
