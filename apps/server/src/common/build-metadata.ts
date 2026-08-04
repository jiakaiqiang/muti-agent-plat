import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

type GitCommand = (args: string[]) => string | undefined;

type RuntimeBuildMonitorOptions = {
  env?: NodeJS.ProcessEnv;
  entryPath?: string;
  runGit?: GitCommand;
  latestModifiedAt?: (root: string) => number | undefined;
};

export type RuntimeBuildMonitor = {
  buildId: string;
  buildTime: string;
  runtimeBuildStale: () => boolean;
};

export function resolveBuildCommit(
  env: NodeJS.ProcessEnv = process.env,
  runGit: GitCommand = runLocalGit
) {
  const configured =
    env.AGENT_CLUSTER_COMMIT?.trim() || env.GIT_COMMIT?.trim() || env.COMMIT_SHA?.trim();
  if (configured) return configured;

  const commit = runGit(['rev-parse', '--short=7', 'HEAD'])?.trim();
  if (!commit) return 'unknown';

  const status = runGit(['status', '--porcelain', '--untracked-files=normal']);
  return status?.trim() ? `${commit}-dirty` : commit;
}

export function captureRuntimeBuildMonitor(options: RuntimeBuildMonitorOptions = {}): RuntimeBuildMonitor {
  const env = options.env ?? process.env;
  const commit = resolveBuildCommit(env, options.runGit ?? runLocalGit);
  const entryPath = resolve(options.entryPath ?? process.argv[1] ?? '');
  const distRoot = runtimeDistRoot(entryPath);
  const latestModifiedAt = options.latestModifiedAt ?? latestJavaScriptModifiedAt;
  const baselineModifiedAt = distRoot ? latestModifiedAt(distRoot) : undefined;
  const configuredBuildTime = env.AGENT_CLUSTER_BUILD_TIME?.trim() || env.BUILD_TIME?.trim();
  const buildTime = configuredBuildTime || (baselineModifiedAt ? new Date(baselineModifiedAt).toISOString() : 'unknown');
  const buildId = env.AGENT_CLUSTER_BUILD_ID?.trim() || `${commit}:${buildTime}`;
  let stale = false;
  let lastCheckedAt = 0;

  return {
    buildId,
    buildTime,
    runtimeBuildStale: () => {
      if (stale || !distRoot || baselineModifiedAt === undefined) return stale;
      const now = Date.now();
      if (now - lastCheckedAt < 500) return false;
      lastCheckedAt = now;
      const currentModifiedAt = latestModifiedAt(distRoot);
      stale = currentModifiedAt !== undefined && currentModifiedAt > baselineModifiedAt;
      return stale;
    }
  };
}

function runtimeDistRoot(entryPath: string) {
  const normalized = entryPath.split(sep).join('/');
  const marker = '/dist/';
  const index = normalized.toLocaleLowerCase().lastIndexOf(marker);
  if (index < 0) return undefined;
  return normalized.slice(0, index + marker.length - 1);
}

function latestJavaScriptModifiedAt(root: string): number | undefined {
  let latest: number | undefined;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        try {
          const modifiedAt = statSync(path).mtimeMs;
          latest = latest === undefined ? modifiedAt : Math.max(latest, modifiedAt);
        } catch {
          // A concurrent build can replace a file between directory listing and stat.
        }
      }
    }
  }
  return latest;
}

function runLocalGit(args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return undefined;
  }
}
