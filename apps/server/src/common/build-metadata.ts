import { execFileSync } from 'node:child_process';

type GitCommand = (args: string[]) => string | undefined;

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
