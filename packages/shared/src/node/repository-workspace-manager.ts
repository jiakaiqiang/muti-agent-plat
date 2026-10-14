import { createHash } from 'node:crypto';
import { mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { normalizeGitHubRepositoryUrl } from '../github-repository-url.js';
import { AuthorizedGit } from './authorized-git.js';
import { candidateRefPrefix } from './git-task-candidate.js';

export type PreparedRepositoryWorkspace = {
  sessionId: string;
  cacheKey: string;
  workspaceId: string;
  workspacePath: string;
  baseBranch: string;
  baseSha: string;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GitRepositoryWorkspaceManager {
  private readonly root: string;
  private readonly git = new AuthorizedGit();

  constructor(
    root = process.env.AGENT_CLUSTER_GITHUB_WORKSPACES_ROOT || join(homedir(), '.agent-cluster', 'github-workspaces'),
    private readonly remoteResolver: (canonicalUrl: string) => string = (url) => url
  ) {
    this.root = resolve(root);
  }

  sessionWorkspacePath(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.root, 'sessions', sessionId);
  }

  taskWorkspacePath(sessionId: string, taskId: string): string {
    this.assertSessionId(sessionId);
    this.assertSessionId(taskId);
    return join(this.root, 'tasks', sessionId, taskId);
  }

  deliveryWorkspacePath(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.root, 'deliveries', sessionId);
  }

  conflictStatePath(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.root, 'conflicts', `${sessionId}.json`);
  }

  async prepareDeliveryAtCommit(sessionId: string, commitSha: string): Promise<string> {
    this.assertSessionId(sessionId);
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('GITHUB_DELIVERY_COMMIT_INVALID');
    const sourcePath = this.sessionWorkspacePath(sessionId);
    const cachePath = await this.cachePathForWorkspace(sourcePath);
    const workspacePath = this.deliveryWorkspacePath(sessionId);
    return this.withCacheLock(basename(cachePath), async () => {
      await this.git.run(cachePath, ['cat-file', '-e', `${commitSha}^{commit}`]);
      if (await exists(workspacePath)) {
        if (await this.cachePathForWorkspace(workspacePath) !== cachePath) {
          throw new Error('GITHUB_DELIVERY_WORKSPACE_MISMATCH');
        }
        await this.git.run(cachePath, ['worktree', 'remove', '--force', workspacePath]);
      }
      await mkdir(join(this.root, 'deliveries'), { recursive: true });
      await this.git.run(cachePath, ['worktree', 'add', '--detach', workspacePath, commitSha]);
      return workspacePath;
    });
  }

  async prepareDelivery(sessionId: string, expectedBaseSha: string,
    rebuild = false, allowHeadMismatch = false): Promise<string> {
    this.assertSessionId(sessionId);
    if (!/^[a-f0-9]{40}$/i.test(expectedBaseSha)) throw new Error('GITHUB_DELIVERY_BASE_INVALID');
    const sourcePath = this.sessionWorkspacePath(sessionId);
    const workspacePath = this.deliveryWorkspacePath(sessionId);
    const cachePath = await this.cachePathForWorkspace(sourcePath);
    return this.withCacheLock(basename(cachePath), async () => {
      const sourceHead = await this.git.run(sourcePath, ['rev-parse', '--verify', 'HEAD']);
      if (sourceHead !== expectedBaseSha) throw new Error('GITHUB_DELIVERY_BASE_CHANGED');
      if (rebuild && await exists(workspacePath)) {
        if (await this.cachePathForWorkspace(workspacePath) !== cachePath) {
          throw new Error('GITHUB_DELIVERY_WORKSPACE_MISMATCH');
        }
        await this.git.run(cachePath, ['worktree', 'remove', '--force', workspacePath]);
      }
      if (!await exists(workspacePath)) {
        await mkdir(join(this.root, 'deliveries'), { recursive: true });
        await this.git.run(cachePath, ['worktree', 'add', '--detach', workspacePath, expectedBaseSha]);
      } else if (await this.cachePathForWorkspace(workspacePath) !== cachePath ||
          !allowHeadMismatch &&
          await this.git.run(workspacePath, ['rev-parse', '--verify', 'HEAD']) !== expectedBaseSha) {
        throw new Error('GITHUB_DELIVERY_WORKSPACE_MISMATCH');
      }
      return workspacePath;
    });
  }

  async prepare(
    sessionId: string, accountId: string, repositoryUrl: string,
    repositoryId: string, token: string, baseBranch: string
  ): Promise<PreparedRepositoryWorkspace> {
    this.assertSessionId(sessionId);
    if (!/^[0-9]+$/.test(accountId) || !/^[0-9]+$/.test(repositoryId) || !token) {
      throw new Error('GITHUB_REPOSITORY_AUTH_REQUIRED');
    }
    const repository = normalizeGitHubRepositoryUrl(repositoryUrl);
    const cacheKey = createHash('sha256').update(`${accountId}:${repositoryId}`).digest('hex');
    const cachePath = join(this.root, 'cache', cacheKey);
    const workspacePath = join(this.root, 'sessions', sessionId);
    await this.assertRootOutsidePlatform();
    await mkdir(this.root, { recursive: true });
    await this.assertRootOutsidePlatform();
    await mkdir(join(this.root, 'cache'), { recursive: true });
    await mkdir(join(this.root, 'sessions'), { recursive: true });
    await mkdir(join(this.root, 'locks'), { recursive: true });
    return this.withCacheLock(cacheKey, async () => {
      const remoteUrl = this.remoteResolver(repository.repositoryUrl);
      if (!await exists(cachePath)) {
        await mkdir(cachePath);
      }
      const initialized = await exists(join(cachePath, 'HEAD'));
      if (!initialized) {
        await this.git.run(cachePath, ['init', '--bare']);
      }
      let existingRemote: string | undefined;
      try {
        existingRemote = await this.git.run(cachePath, ['remote', 'get-url', 'origin']);
      } catch {
        await this.git.run(cachePath, ['remote', 'add', 'origin', remoteUrl]);
      }
      if (existingRemote !== undefined) {
        if (existingRemote !== remoteUrl) {
          if (this.remoteResolver(repository.repositoryUrl) !== repository.repositoryUrl) {
            throw new Error('GITHUB_CACHE_REMOTE_MISMATCH');
          }
          normalizeGitHubRepositoryUrl(existingRemote);
          await this.git.run(cachePath, ['remote', 'set-url', 'origin', remoteUrl]);
        }
      }
      await this.git.run(cachePath,
        ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], token);
      const ref = await this.remoteRef(cachePath, baseBranch);
      const baseSha = await this.git.run(cachePath, ['rev-parse', '--verify', `${ref}^{commit}`]);
      if (!await exists(workspacePath)) {
        await this.git.run(cachePath, ['worktree', 'add', '--detach', workspacePath, ref]);
      } else {
        const common = await this.git.run(workspacePath, ['rev-parse', '--git-common-dir']);
        if (resolve(workspacePath, common) !== await realpath(cachePath)) {
          throw new Error('GITHUB_SESSION_WORKSPACE_MISMATCH');
        }
      }
      return { sessionId, cacheKey, workspaceId: `github-session:${sessionId}`,
        workspacePath, baseBranch, baseSha };
    });
  }

  async selectBaseBranch(sessionId: string, baseBranch: string): Promise<{ baseSha: string }> {
    this.assertSessionId(sessionId);
    const workspacePath = join(this.root, 'sessions', sessionId);
    const cachePath = await this.cachePathForWorkspace(workspacePath);
    return this.withCacheLock(basename(cachePath), async () => {
      const ref = await this.remoteRef(cachePath, baseBranch);
      const status = await this.git.run(workspacePath, ['status', '--porcelain']);
      if (status) throw new Error('GITHUB_BASE_BRANCH_WORKSPACE_DIRTY');
      await this.git.run(workspacePath, ['checkout', '--detach', ref]);
      return { baseSha: await this.git.run(workspacePath, ['rev-parse', 'HEAD']) };
    });
  }

  async listBranches(sessionId: string): Promise<Array<{ name: string; sha: string }>> {
    this.assertSessionId(sessionId);
    const workspacePath = join(this.root, 'sessions', sessionId);
    const cachePath = await this.cachePathForWorkspace(workspacePath);
    const output = await this.withCacheLock(basename(cachePath), () => this.git.run(cachePath,
      ['for-each-ref', '--format=%(refname:strip=3)%09%(objectname)', 'refs/remotes/origin']));
    return output.split('\n').filter(Boolean).map((line) => {
      const [name, sha] = line.trim().split('\t');
      if (!name || !sha || !/^[a-f0-9]{40}$/i.test(sha)) {
        throw new Error('GITHUB_BRANCH_LIST_INVALID');
      }
      return { name, sha };
    }).filter((branch) => branch.name !== 'HEAD');
  }

  async prepareTask(sessionId: string, taskId: string): Promise<{ workspacePath: string; baseCommit: string }> {
    const sourcePath = this.sessionWorkspacePath(sessionId);
    const workspacePath = this.taskWorkspacePath(sessionId, taskId);
    const cachePath = await this.cachePathForWorkspace(sourcePath);
    return this.withCacheLock(basename(cachePath), async () => {
      const baseCommit = await this.git.run(sourcePath, ['rev-parse', '--verify', 'HEAD']);
      if (!await exists(workspacePath)) {
        await mkdir(join(this.root, 'tasks', sessionId), { recursive: true });
        await this.git.run(cachePath, ['worktree', 'add', '--detach', workspacePath, baseCommit]);
      } else if (await this.cachePathForWorkspace(workspacePath) !== cachePath ||
          await this.git.run(workspacePath, ['rev-parse', '--verify', 'HEAD']) !== baseCommit) {
        throw new Error('GITHUB_TASK_WORKSPACE_MISMATCH');
      }
      return { workspacePath, baseCommit };
    });
  }

  async cleanupSession(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    const workspacePath = join(this.root, 'sessions', sessionId);
    const taskDirectory = join(this.root, 'tasks', sessionId);
    const taskIds = await readdir(taskDirectory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    });
    let cachePath: string | undefined;
    for (const taskId of taskIds) {
      const taskPath = this.taskWorkspacePath(sessionId, taskId);
      const taskCachePath = await this.cachePathForWorkspace(taskPath);
      cachePath = taskCachePath;
      await this.withCacheLock(basename(taskCachePath), () => this.git.run(taskCachePath,
        ['worktree', 'remove', '--force', taskPath]));
    }
    if (taskIds.length) await rm(taskDirectory, { recursive: true, force: true });
    const deliveryPath = this.deliveryWorkspacePath(sessionId);
    if (await exists(deliveryPath)) {
      const deliveryCachePath = await this.cachePathForWorkspace(deliveryPath);
      cachePath = deliveryCachePath;
      await this.withCacheLock(basename(deliveryCachePath), () => this.git.run(deliveryCachePath,
        ['worktree', 'remove', '--force', deliveryPath]));
    }
    if (await exists(workspacePath)) {
      cachePath = await this.cachePathForWorkspace(workspacePath);
      await this.withCacheLock(basename(cachePath), () => this.git.run(cachePath!,
        ['worktree', 'remove', '--force', workspacePath]));
    }
    if (cachePath) {
      await this.withCacheLock(basename(cachePath), async () => {
        const prefix = candidateRefPrefix(sessionId);
        const refs = await this.git.run(cachePath!,
          ['for-each-ref', '--format=%(refname)', prefix]);
        for (const ref of refs.split('\n').filter(Boolean)) {
          if (!ref.startsWith(prefix)) throw new Error('GITHUB_CANDIDATE_REF_MISMATCH');
          await this.git.run(cachePath!, ['update-ref', '-d', ref]);
        }
      });
    }
    await rm(this.conflictStatePath(sessionId), { force: true });
  }

  private async cachePathForWorkspace(workspacePath: string): Promise<string> {
    const common = await this.git.run(workspacePath, ['rev-parse', '--git-common-dir']);
    const cachePath = await realpath(resolve(workspacePath, common));
    const cacheRoot = await realpath(join(this.root, 'cache'));
    if ((!cachePath.startsWith(`${cacheRoot}\\`) && !cachePath.startsWith(`${cacheRoot}/`)) ||
        !/^[a-f0-9]{64}$/.test(basename(cachePath))) {
      throw new Error('GITHUB_SESSION_WORKSPACE_MISMATCH');
    }
    return cachePath;
  }

  private async remoteRef(cachePath: string, branch: string): Promise<string> {
    if (!branch || branch.length > 200) throw new Error('GITHUB_BASE_BRANCH_INVALID');
    const ref = `refs/remotes/origin/${branch}`;
    await this.git.run(cachePath, ['check-ref-format', ref]);
    await this.git.run(cachePath, ['show-ref', '--verify', ref]);
    return ref;
  }

  private async withCacheLock<T>(cacheKey: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, 'locks', `${cacheKey}.lock`);
    const deadline = Date.now() + 130_000;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try { handle = await open(lockPath, 'wx'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('GITHUB_CACHE_LOCK_TIMEOUT');
        let age: number;
        try { age = Date.now() - (await stat(lockPath)).mtimeMs; }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (age > 300_000) throw new Error('GITHUB_CACHE_STALE_LOCK');
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    try { return await operation(); }
    finally {
      await handle.close();
      const { unlink } = await import('node:fs/promises');
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async assertRootOutsidePlatform(): Promise<void> {
    const platform = await realpath(process.env.AGENT_CLUSTER_PLATFORM_ROOT?.trim() || process.cwd());
    const candidate = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
    const normalizedPlatform = process.platform === 'win32' ? platform.toLowerCase() : platform;
    if (candidate === normalizedPlatform || candidate.startsWith(`${normalizedPlatform}\\`) ||
        candidate.startsWith(`${normalizedPlatform}/`)) {
      throw new Error('GITHUB_WORKSPACE_ROOT_INSIDE_PLATFORM');
    }
    const actual = await realpath(this.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.root;
      throw error;
    });
    const normalizedActual = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (normalizedActual === normalizedPlatform || normalizedActual.startsWith(`${normalizedPlatform}\\`) ||
        normalizedActual.startsWith(`${normalizedPlatform}/`)) {
      throw new Error('GITHUB_WORKSPACE_ROOT_INSIDE_PLATFORM');
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new Error('GITHUB_SESSION_ID_INVALID');
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
